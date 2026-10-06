#!/bin/sh
# One-time setup on the printer host: install the cockpit-klipper-flash
# systemd unit. Run it from this checkout as the Klipper user; it asks for
# sudo. Run it again after pulling changes to the unit template.
#
# This file may be distributed under the terms of the GNU GPLv3 license.

set -eu

usage() {
    cat >&2 <<EOF
usage: $0 [-k KLIPPER_SERVICE] [-n]
  -k NAME  Klipper's systemd service (default: klipper); keep it the same
           as KLIPPER_SERVICE in the settings file
  -n       print the filled-in unit and install nothing
EOF
    exit 2
}

die() {
    printf 'error: %s\n' "$*" >&2
    exit 1
}

# only CHARS VALUE: true if VALUE is non-empty and consists of CHARS only.
only() {
    [ -n "$2" ] && [ "$(printf '%s' "$2" | tr -cd "$1")" = "$2" ]
}

klipper_service=klipper
dry_run=no
while getopts k:n opt; do
    case $opt in
        k) klipper_service=$OPTARG ;;
        n) dry_run=yes ;;
        *) usage ;;
    esac
done
shift $((OPTIND - 1))
[ $# -eq 0 ] || usage

[ "$(id -u)" -ne 0 ] || die "run this as the Klipper user, not as root; it uses sudo itself"

repo=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
template=$repo/systemd/cockpit-klipper-flash.service
worker=$repo/bin/klipper-mcu-flash
user=$(id -un)
name=cockpit-klipper-flash.service
unit=/etc/systemd/system/$name

case $klipper_service in
    [A-Za-z0-9]*) ;;
    *) die "unsupported service name '$klipper_service'" ;;
esac
case $klipper_service in
    *.service) ;;
    *) klipper_service=$klipper_service.service ;;
esac

# The values end up unquoted in the unit's Exec lines, and in sed.
only 'A-Za-z0-9._/+-' "$worker" || die "unsupported characters in path $worker"
only 'a-z0-9_-' "$user" || die "unsupported user name $user"
only 'A-Za-z0-9@._-' "$klipper_service" || die "unsupported service name $klipper_service"
[ -f "$template" ] || die "$template is missing"
[ -x "$worker" ] || die "$worker is missing or not executable"

[ "$(systemctl show -p LoadState --value -- "$klipper_service")" = loaded ] ||
    die "there is no service $klipper_service; give Klipper's service with -k"
kuser=$(systemctl show -p User --value -- "$klipper_service")
[ -z "$kuser" ] || [ "$kuser" = "$user" ] ||
    die "$klipper_service runs as $kuser; run install.sh as $kuser"

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
trap 'exit 1' HUP INT TERM
sed -e "s|@USER@|$user|g" \
    -e "s|@WORKER@|$worker|g" \
    -e "s|@KLIPPER_SERVICE@|$klipper_service|g" \
    "$template" >"$tmp"
if grep -q '@[A-Z_]*@' "$tmp"; then
    die "unfilled placeholder in the rendered unit"
fi

if [ "$dry_run" = yes ]; then
    cat "$tmp"
    exit 0
fi

# Replacing the unit during a run could make systemd skip steps of it.
case $(systemctl show -p ActiveState --value "$name") in
    activating|deactivating|reloading|refreshing)
        die "a run is in progress; try again when it has finished" ;;
esac

if [ -f "$unit" ] && cmp -s "$tmp" "$unit"; then
    if [ "$(systemctl show -p NeedDaemonReload --value "$name")" = yes ]; then
        sudo systemctl daemon-reload
    fi
    echo "$unit is already up to date"
    exit 0
fi
if [ -f "$unit" ]; then
    diff -u "$unit" "$tmp" || true
fi
sudo install -m 644 "$tmp" "$unit"
sudo systemctl daemon-reload
echo "Installed $unit"
echo "Start a run:  systemctl start --no-block $name"
echo "Follow it:    journalctl -f -o cat -u $name"
