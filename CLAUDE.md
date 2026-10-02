# cockpit-klipper — notes for Claude Code sessions

A Cockpit page plus a oneshot systemd service. It builds Klipper MCU firmware
from the Klipper source already installed on the printer host and flashes it
to the printer's controller board. Klipper host updates still happen in
Mainsail's Update Manager. Afterwards the tool brings the board to the same
version safely, in one click.

Status (2026-10-02): the design is agreed in outline and no code exists yet.
This file was folded in from a handoff written at the end of a session in
the private `printer-config` repo. Facts marked **(verified)** were checked
against the printer or the upstream source on that date. Everything else is
a proposal.

First target: a CR-10S with a BTT SKR 1.3 (LPC1768, SD-card bootloader).
Keep the tool generic.

## This repo is public

- GitHub `akreager/cockpit-klipper`, public, GPLv3 (the same as Klipper and
  Moonraker, so their code can be reused here).
- Printer-specific values stay in the private `printer-config` repo
  (Gitea): the board's Klipper `.config`, its `/dev/serial/by-id/…` path,
  the `flash-sdcard.sh` board name, local paths and host addresses. This
  repo ships examples with placeholder values only. Never commit the real
  ones.

## Settled decisions (do not re-litigate)

- **Not a Klipper macro and not a Moonraker-managed service.**
  - Flashing needs exclusive use of the board's USB serial port, so Klipper
    must be stopped. Stopping `klipper.service` kills everything Klipper
    started. `RUN_SHELL_COMMAND` also blocks G-code and kills its child at
    the timeout.
  - Macros cannot run while Klipper is in an error state, e.g. an MCU
    protocol mismatch after a host update. That is exactly when a flash is
    needed.
  - Allen does host maintenance in Cockpit (as the Klipper user, with
    administrative access) and wants the tool there.
- **The page is only the UI; a oneshot systemd unit does the work.**
  Processes spawned from a Cockpit page are tied to that Cockpit session.
  Closing the tab or a session timeout mid-flash must not leave the board
  half-flashed with Klipper stopped. The unit also works from Cockpit's
  built-in *Services* page and journal before the page exists.
- **Root only ever runs fixed lines in the root-owned unit file**
  (`systemctl stop/start klipper`). The build and the flash run as the
  Klipper user.
- **The tool never updates Klipper.** It builds from whatever Klipper
  source is installed and never `git pull`s it. It shows when the board is
  behind the host and fixes that.
- **Klipper stays on Moonraker's `dev` update channel.** Do not propose
  `channel: stable` (see "Why not the stable channel" below).

## How flashing works on this board (verified in Klipper @ `2d7717e3`)

- **`make flash` is the wrong tool.** For lpc176x it calls `flash_usb.py`,
  which uses `dfu-util` and only works with Smoothieware's DFU bootloader.
  The SKR 1.3 has an SD-card bootloader.
- **Use `scripts/flash-sdcard.sh`:**
  `flash-sdcard.sh [-c] [-s] [-b baud] [-f klipper.bin] [-d klipper.dict] <device> <board>`.
  - `btt-skr-v1.3` is an alias of `generic-lpc1768` (`spi_bus: ssp1`,
    `cs_pin: P0.6`) in `scripts/spi_flash/board_defs.py`.
  - It talks to the running Klipper firmware and writes `firmware.bin` to
    the board's SD card over SPI. It then resets the board; the bootloader
    flashes the file and renames it `FIRMWARE.CUR`.
  - It then reconnects and checks the MCU's data dictionary against the
    given `klipper.dict`.
  - It hard-codes `${HOME}/klippy-env/bin/python`.
  - Docs: `docs/SDCard_Updates.md`.
- **Requirements:**
  - Klipper must be stopped. Both Klipper (`serialhdl.py`) and the flasher
    open the port with `exclusive=True`.
  - A FAT/FAT32 SD card must be in the board's slot.
  - `-s` (4 MHz SPI) helps if the card fails to initialise.
- **Build:**
  `make -C <klipper> clean && make -C <klipper> -j"$(nproc)" KCONFIG_CONFIG=<file>`.
  - The Makefile sets `KCONFIG_CONFIG := $(CURDIR)/.config`, which a
    command-line value overrides.
  - When Klipper's Kconfig sources are newer, `olddefconfig` **rewrites the
    config file in place**. Always build from a temporary copy. Rewriting
    the copy tracked in `printer-config` would leave that repo dirty on the
    printer and block Moonraker's updates of it.
- **The SKR 1.3's config:** LPC1768, USB comms, "16KiB bootloader"
  (`LPC_FLASH_START_4000`), which gives
  `CONFIG_FLASH_APPLICATION_ADDRESS=0x4000`.
- **Validation data:**
  - `out/klipper.dict` is JSON with `version`, `build_versions`, `config`
    (the MCU constants such as `MCU`, `CLOCK_FREQ`, `RESERVE_PINS_USB`) and
    `kconfig`.
  - The running firmware exposes the same through Klipper's `mcu` status
    object: `mcu_version`, `mcu_build_versions`, `mcu_constants`,
    `mcu_kconfig`.
  - Compare the two **before** stopping Klipper.
- **Versions:** the host's version can carry a `-dirty` suffix when the
  Klipper checkout has untracked extras (e.g. third-party `klippy/extras/`
  modules). Strip it when comparing.
- **Klipper API socket:** JSON messages terminated by `0x03`
  (`docs/API_Server.md`). For example:
  `{"id":1,"method":"objects/query","params":{"objects":{"print_stats":["state"],"mcu":["mcu_version"]}}}`.
  `print_stats.state` is one of `standby`, `printing`, `paused`,
  `complete`, `cancelled`, `error`.
- **Power:** a Moonraker power device's `off_when_shutdown: true` acts
  only on a Klipper *shutdown* state (`moonraker/components/power.py`).
  Stopping the Klipper service for a flash does not cut the printer's
  power.

## Cockpit facts (verified in docs.cockpit-project.org/cockpit-guide/latest/guide/)

- **Packages** are folders with a `manifest.json`, searched in
  `~/.local/share/cockpit/`, `/usr/local/share/cockpit/` and
  `/usr/share/cockpit/`. Packages in `~/.local/share/cockpit` are **not
  cached**, so a symlink to a git checkout picks up changes on reload.
- **Manifest:**
  `{"version": 0, "require": {"cockpit": "…"}, "conditions": [{"path-exists": "…"}], "tools": {"klipper-mcu": {"label": "Klipper MCU", "path": "index.html"}}}`.
- **Strict CSP by default:** no inline scripts or styles and nothing
  external. Ship the JS and CSS as files and load `../base1/cockpit.js`.
- **APIs:**
  - `cockpit.spawn(argv, {superuser: "require"|"try", err: "out"})` with
    `.stream()` for live output.
  - `cockpit.channel({payload: "stream", unix: "<socket>"})` opens a raw
    unix-socket channel (`doc/protocol.md`), so the page can talk to
    Klipper's API socket directly without Moonraker.
  - `cockpit.http(port | unix path)` and `cockpit.file()`.
- **Version:** the first target host runs Cockpit 362. Do not raise the
  manifest's `require` above what the page actually needs.
- **Not yet checked:** how a hand-written page follows Cockpit's
  light/dark theme.

## Design (agreed in outline; details open)

### Repo layout

```
README.md  LICENSE
bin/klipper-mcu-flash                worker: build | check-idle | flash | status
systemd/klipper-mcu-flash.service    template, installed to /etc/systemd/system
cockpit/                             the page: manifest.json index.html mcu.js mcu.css
examples/mcu-flash.conf              sample settings
install.sh                           optional one-time setup
```

### Settings

A shell-style file at `firmware/mcu-flash.conf` in `printer-config`, next to
the board's kconfig (`firmware/<board>.config`). Decided 2026-10-02. This
repo ships only `examples/mcu-flash.conf`.

```sh
KLIPPER_DIR=/home/<user>/klipper
KLIPPY_ENV=/home/<user>/klippy-env
KCONFIG=/home/<user>/printer_data/config/firmware/<board>.config
DEVICE=/dev/serial/by-id/usb-Klipper_<mcu>_<serial>-if00
BOARD=btt-skr-v1.3
KLIPPER_SERVICE=klipper
KLIPPY_SOCKET=/home/<user>/printer_data/comms/klippy.sock
```

### The unit (sketch)

```ini
[Unit]
Description=Build Klipper firmware and flash it to the printer board

[Service]
Type=oneshot
User=<user>
ExecStartPre=/path/to/klipper-mcu-flash build        # as the user, Klipper still running
ExecStartPre=/path/to/klipper-mcu-flash check-idle   # refuse if printing/paused or board absent
ExecStartPre=+/usr/bin/systemctl stop klipper.service   # "+" = this line runs as root
ExecStart=/path/to/klipper-mcu-flash flash            # flash-sdcard.sh -f out/klipper.bin -d out/klipper.dict
ExecStopPost=+/usr/bin/systemctl start --no-block klipper.service   # always, even after a failure
TimeoutStartSec=15min
```

- systemd's `%h` is root's home in system units even with `User=`, so the
  install step writes full paths into the template.
- `ExecStopPost=` also runs when an `ExecStartPre=` step fails, so Klipper
  is always restarted. But see the first open point below.

### The worker (`bin/klipper-mcu-flash`)

- **`build`:**
  - Copy `KCONFIG` to a temporary file, then `make clean` and `make`.
  - Validate `out/klipper.dict`: `MCU`, `CLOCK_FREQ` and `RESERVE_PINS_USB`
    must match the expected values and the running firmware's
    `mcu_constants`. `kconfig` vs `mcu_kconfig` flags config changes.
    Check `FLASH_APPLICATION_ADDRESS` (`0x4000` on the SKR 1.3).
  - Report the built version against the running `mcu_version`.
    Optionally stop with "nothing to do" when they already match, unless
    forced.
- **`check-idle`:**
  - Runs **after** the build, immediately before Klipper is stopped, so a
    print started during the build cannot be cut off.
  - Queries `print_stats.state` over the API socket and refuses on
    `printing` or `paused`. A missing socket means Klipper is not running,
    which is fine.
  - Fails if `DEVICE` does not exist ("printer powered off?"). It only
    reports this; it never switches the printer on.
  - This check must live in the worker, not only in the page, because the
    unit can also be started from Cockpit's *Services* page or the CLI.
- **`flash`:** run `flash-sdcard.sh` with the built `.bin` and `.dict`, and
  exit non-zero on failure.
- **Optional after the flash:**
  - Wait for Klipper to report ready, read `mcu_version` and print the
    result.
  - Send a `RESPOND` through the API socket's `gcode/script` so Mainsail
    and KlipperScreen show what happened.

### The page

- **Status:**
  - Host version: `git -C $KLIPPER_DIR describe --always --tags --long --dirty`.
  - Board version: `mcu.mcu_version` over the API socket. If Klipper is
    down, use the last `Loaded MCU 'mcu'` line in klippy.log.
  - How many commits apart they are, whether the board is connected,
    Klipper state and print state.
  - Last run result:
    `systemctl show klipper-mcu-flash -p Result -p ExecMainExitTimestamp`.
- **Build only:** runs `klipper-mcu-flash build` directly as the logged-in
  user, with output streamed live. Klipper is not stopped.
- **Build & flash:**
  - Disabled while printing or when the board is absent. When the board
    is absent the page says the printer looks switched off and leaves it at
    that: no power-on button through Moonraker (decided 2026-10-02).
  - After a confirmation, run
    `systemctl start --no-block klipper-mcu-flash.service` with
    `superuser: "require"`.
  - Stream `journalctl -f -o cat -u klipper-mcu-flash.service` and show the
    result once the unit is inactive or failed.
  - Warn not to restart Klipper from Mainsail or KlipperScreen while it
    runs.
- **Privileges:** starting the unit uses Cockpit's administrative access.
  Optional later: a polkit rule that lets the Klipper user start just this
  unit without admin mode.

### One-time install on the printer host (sketch)

```sh
git clone https://github.com/akreager/cockpit-klipper.git ~/cockpit-klipper
cp ~/klipper/.config ~/printer_data/config/firmware/<board>.config   # commit it in printer-config
ln -s ~/cockpit-klipper/cockpit ~/.local/share/cockpit/klipper-mcu
sudo install -m 644 <unit with paths filled in> /etc/systemd/system/klipper-mcu-flash.service
sudo systemctl daemon-reload
```

## Open design points

- **Do not start Klipper if the unit did not stop it.** A Moonraker power
  device with `bound_services: klipper` (the CR-10S has one) stops Klipper
  whenever the printer's plug is off (seen 2026-10-02: plug off,
  `klippy_state: disconnected`). A run started then fails in `check-idle`,
  yet the unconditional `ExecStopPost=` would start Klipper, which then
  sits in an error state because the board is missing. Restart only when
  the stop line actually stopped an active Klipper, e.g. by recording that
  in a `RuntimeDirectory=` file. Both lines stay fixed in the unit file.
- **Board version while the printer is off:** klippy.log then holds only
  `Unable to open serial port` lines. Fall back to the rotated
  `klippy.log.YYYY-MM-DD` files, whose headers repeat the
  `Loaded MCU 'mcu' …` line, or show "unknown".
- How the unit and the page find the settings file, e.g. a fixed path or
  an `Environment=` line in the installed unit.
- How the page follows Cockpit's light/dark theme.

## Risks and failure modes

- **Wrong firmware flashed:** the board will not run Klipper. Recovery is
  to put a good build on the board's SD card as `firmware.bin` by hand,
  which means opening the printer's control box. Mitigation: validate the
  dictionary before Klipper is stopped.
- **No SD card or a bad one:** the upload fails and the old firmware
  stays. Klipper is restarted and nothing changes.
- **Klipper restarted from Mainsail or KlipperScreen mid-flash:** both
  processes want the port exclusively, so verification may fail. Re-run
  it; the firmware is usually already written.
- **Printer powered off:** the device is missing. Fail fast with a clear
  message before anything is stopped.
- **During a print:** `check-idle` refuses.
- **Downtime:** Klipper is down for roughly a minute per flash (an
  estimate).

## Working here

- The dev machine (aenima-ubuntu) is not the printer host. Reading the
  printer through Moonraker's HTTP API works from here; building and
  flashing happen on the printer host, run by Allen or through Cockpit's
  terminal. Do nothing from here that changes the printer's state (power,
  service restarts, flashing) without asking.
- Moonraker serves only the `config`, `logs` and `gcodes` roots; nothing in
  the Klipper checkout is reachable through it.
- Run every shell script through `shellcheck`.
- Order of work:
  1. Write the worker first. `build`, `status` and `check-idle` can run by
     hand on the printer host without stopping anything.
  2. Install the unit and test the failure paths first: printer powered off
     (must fail before Klipper is stopped, and must not start Klipper),
     then a print running (must refuse). Only then a real flash, with the
     printer idle.
  3. Build the page last and test it in Cockpit.
  4. After the first real flash, confirm the board's `mcu_version` equals
     the host version in klippy.log or Mainsail.
- `printer-config` workflow: edit → commit → push to Gitea → the printer
  pulls through Mainsail's Update Manager. Printer-side edits go back with
  the `PUSH_CONFIG` macro. Files there also appear in Mainsail's config
  file browser.

## Why not the stable channel (verified 2026-09-30)

- Klipper has no stable branch. Releases are tags on `master`: v0.11.0
  (2022-11-29), v0.12.0 (2023-11-10), v0.13.0 (2025-04-12), and none since.
- Moonraker v0.11 supports `[update_manager klipper]` with
  `channel: stable|beta|dev` and `pinned_commit:`.
- On `stable` it only considers tags that contain the current commit
  (`for-each-ref --contains=HEAD`), so it would freeze Klipper at the
  current commit until the next release, with no fixes in between.
- A one-click, version-aware flash removes the reason to freeze, so Klipper
  stays on `dev`.

## Sources

- **Klipper @ `2d7717e3`:**
  - `scripts/flash-sdcard.sh`, `scripts/spi_flash/{spi_flash.py,board_defs.py}`,
    `docs/SDCard_Updates.md`
  - `src/lpc176x/{Makefile,Kconfig}`, `Makefile`
  - `klippy/{mcu.py,serialhdl.py}`, `docs/API_Server.md`,
    `scripts/buildcommands.py`
- **Moonraker @ `9e676eba`:** `docs/configuration.md` (`[update_manager]`,
  allowed services), `moonraker/components/update_manager/git_deploy.py`,
  `moonraker/components/power.py`.
- **Cockpit:** guide pages `packages`, `cockpit-spawn`, `cockpit-http` and
  `cockpit-channels`; `doc/protocol.md` in the cockpit repo (stream payload
  options).
