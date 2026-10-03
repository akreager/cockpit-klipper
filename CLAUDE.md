# cockpit-klipper — notes for Claude Code sessions

A Cockpit page plus a oneshot systemd service. It builds Klipper MCU firmware
from the Klipper source already installed on the printer host and flashes it
to the printer's controller board. Klipper host updates still happen in
Mainsail's Update Manager. Afterwards the tool brings the board to the same
version safely, in one click.

Status (2026-10-02): the worker `bin/klipper-mcu-flash` exists and passes
its tests on the dev machine (see "Working here"). It has not run on the
printer host yet. The systemd unit and the Cockpit page are not written.
This file began as a handoff from a session in the private `printer-config`
repo. Facts marked **(verified)** were checked against the printer or the
upstream source on that date.

First target: a CR-10S with a BTT SKR 1.3 (LPC1768, SD-card bootloader).
Keep the tool generic.

## This repo is public

- GitHub `akreager/cockpit-klipper`, public, GPLv3 (the same as Klipper and
  Moonraker, so their code can be reused here).
- Printer-specific values stay in the private `printer-config` repo
  (Gitea): the board's Klipper `.config`, its `/dev/serial/by-id/…` path,
  the flasher's board name, local paths and host addresses. This
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
- **Use Klipper's SD-card flasher.** `scripts/flash-sdcard.sh` is a thin
  wrapper that runs
  `${HOME}/klippy-env/bin/python scripts/spi_flash/spi_flash.py [-c] [-s] [-b baud] [-d klipper.dict] <device> <board> <klipper.bin>`.
  The worker calls `spi_flash.py` directly with `KLIPPY_ENV`'s Python, so a
  venv elsewhere works too. `spi_flash.py -l` lists the boards; it exits
  255 on any failure and 0 after "SD Card Flash Complete".
  - `btt-skr-v1.3` is an alias of `generic-lpc1768` (`spi_bus: ssp1`,
    `cs_pin: P0.6`) in `scripts/spi_flash/board_defs.py`.
  - It talks to the running Klipper firmware and writes `firmware.bin` to
    the board's SD card over SPI. It then resets the board; the bootloader
    flashes the file and renames it `FIRMWARE.CUR`.
  - It then reconnects and checks the MCU's data dictionary against the
    given `klipper.dict`.
  - Docs: `docs/SDCard_Updates.md`.
- **Requirements:**
  - Klipper must be stopped. Both Klipper (`serialhdl.py`) and the flasher
    open the port with `exclusive=True`.
  - A FAT/FAT32 SD card must be in the board's slot.
  - `-s` (4 MHz SPI) helps if the card fails to initialise.
- **Build:**
  `make -C <klipper> KCONFIG_CONFIG=<file> OUT=<dir>/ olddefconfig`, then
  the same with `-j"$(nproc)"` instead of `olddefconfig`.
  - The Makefile sets `KCONFIG_CONFIG := $(CURDIR)/.config` and `OUT=out/`;
    command-line values override both. An absolute `OUT` works (verified by
    building the SKR 1.3 config), so builds never touch `~/klipper/out`.
  - `make clean` is just `rm -rf $(OUT)`.
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
  - `kconfig` is the *minimal* config (`savedefconfig` output), so it lists
    only non-default values. For the SKR 1.3 it is just
    `CONFIG_LOW_LEVEL_OPTIONS=y` and `CONFIG_MACH_LPC176X=y`. It was added
    in v0.13.0-752 (`8aa2ed308`); older firmware reports `None`.
  - The running firmware exposes the same through Klipper's `mcu` status
    object: `mcu_version`, `mcu_build_versions`, `mcu_constants`,
    `mcu_kconfig`. These are set when Klipper identifies the MCU, so they are
    there even in an MCU protocol error.
  - klippy.log records them on every connect (`klippy/mcu.py` `log_info`):
    `Loaded MCU 'mcu' <n> commands (<version> / <build_versions>)`, then
    `MCU 'mcu' config: K=V …`, then `MCU 'mcu' kconfig: <repr>`. Rotated
    `klippy.log.YYYY-MM-DD` files repeat them in their header.
  - Compare the build with the board **before** stopping Klipper.
- **Versions:** compare commits (`-g<hash>`), never version strings. Both
  Klipper and `buildcommands.py` use `git describe --always --tags --long
  --dirty`. When that says dirty, the firmware version also gets
  `-<build time>-<hostname>` appended. Hash abbreviations differ in length
  (Moonraker `g2d7717e3`, Klipper `g2d7717e3b`).
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

## Design

### Repo layout

```
README.md  LICENSE
bin/klipper-mcu-flash                worker: status | build | preflight | flash   (written)
examples/mcu-flash.conf              every setting, with defaults                  (written)
systemd/klipper-mcu-flash.service    template, installed to /etc/systemd/system    (to do)
cockpit/                             the page: manifest.json index.html mcu.js mcu.css (to do)
install.sh                           optional one-time setup                       (to do)
```

### Settings

`KEY=value` lines, documented in `examples/mcu-flash.conf`. Values are
literal (no `$VAR`; a leading `~/` is expanded) and unknown keys are an
error. The worker reads `-c FILE`, else `$KLIPPER_MCU_FLASH_CONF`, else
`~/printer_data/config/firmware/mcu-flash.conf`. For the CR-10S that file
lives in `printer-config` next to the board's kconfig
(`firmware/skr13.config`); this repo ships only the example.

### The unit (sketch)

```ini
[Unit]
Description=Build Klipper firmware and flash it to the printer board

[Service]
Type=oneshot
User=<user>
ExecStartPre=/path/to/klipper-mcu-flash build        # as the user, Klipper still running
ExecStartPre=/path/to/klipper-mcu-flash preflight    # refuse if printing/paused or board absent
ExecStartPre=+/usr/bin/systemctl stop klipper.service   # "+" = this line runs as root
ExecStart=/path/to/klipper-mcu-flash flash
ExecStopPost=+/usr/bin/systemctl start --no-block klipper.service   # see the first open point
TimeoutStartSec=15min
```

- systemd's `%h` is root's home in system units even with `User=`, so the
  install step writes full paths into the template.
- `ExecStopPost=` also runs when an `ExecStartPre=` step fails, so Klipper
  is always restarted. But see the first open point below.

### The worker (`bin/klipper-mcu-flash`)

Python 3, standard library only (it needs JSON and a unix-socket client;
the host runs Python 3.12). Exit status 1 with `error: …` on stderr for
any refusal. All output is line-buffered for the journal and the page.

- **The board's firmware** comes from Klipper's `mcu` object when Klipper
  has talked to the board, else from the newest klippy.log (current, then
  rotated by mtime) that has a `Loaded MCU 'mcu'` record.
- **`status [--json]`:** host `git describe`, board version and source,
  commits behind/ahead (`git rev-list --count`), whether `DEVICE` exists,
  service state, Klipper state and message, print and idle state, last
  validated build. `--json` is meant for the page.
- **`build`:**
  - Deletes the previous `build.json` first, so a failed or rejected build
    can never be flashed.
  - Copies `KCONFIG` to `BUILD_DIR/kconfig`, runs `olddefconfig` on the
    copy, reports what that added, changed or dropped, then builds into
    `BUILD_DIR/out/`.
  - Validates against the board's firmware. `MCU`, `CLOCK_FREQ` and every
    `RESERVE_PINS_*` constant (which shows the comms: USB vs UART) must
    match. `CONFIG_FLASH_APPLICATION_ADDRESS` must match
    `FLASH_APPLICATION_ADDRESS` when that is set. With no record of the
    board at all, it refuses. A `kconfig` difference is only a warning, and
    so is "the board already runs this commit".
  - On success it writes `BUILD_DIR/build.json` with the version, commit
    and SHA-256 of `klipper.bin` and `klipper.dict`.
- **`preflight`** (called `check-idle` in the handoff):
  - Runs **after** the build, immediately before Klipper is stopped, so a
    print started during the build cannot be cut off.
  - Requires a validated build whose files still match their hashes, that
    `DEVICE` exists ("Is the printer switched on?"; it never powers
    anything on), and that `spi_flash.py -l` knows `BOARD`.
  - Refuses on `print_stats.state` `printing`/`paused` or
    `idle_timeout.state` `Printing`. A missing socket or a refused
    connection means Klipper is not running, which is fine. A socket that
    does not answer within 5 s is a refusal.
  - This check must live in the worker, not only in the page, because the
    unit can also be started from Cockpit's *Services* page or the CLI.
- **`flash`:** re-checks the build's hashes, refuses while Klipper answers on
  its socket, then runs `spi_flash.py [FLASH_ARGS] -d klipper.dict DEVICE
  BOARD klipper.bin` and exits non-zero on failure.
- `build` and `flash` hold an flock on `BUILD_DIR/lock`, so they cannot
  overlap.
- **Not done (optional later):**
  - Wait for Klipper to report ready, read `mcu_version` and print the
    result.
  - Send a `RESPOND` through the API socket's `gcode/script` so Mainsail
    and KlipperScreen show what happened.

### The page

- **Status:**
  - `klipper-mcu-flash status --json` gives the versions, how far apart
    they are, whether the board is connected, Klipper state and print
    state, and the last build.
  - Last run result:
    `systemctl show klipper-mcu-flash -p Result -p ExecMainExitTimestamp`.
- **Build only:** runs `klipper-mcu-flash build` directly as the logged-in
  user, with output streamed live. Klipper is not stopped.
- **Build & flash:**
  - Disabled while the unit runs, while printing, or when the board is
    absent. When the board
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
  `klippy_state: disconnected`). A run started then fails in `preflight`,
  yet the unconditional `ExecStopPost=` would start Klipper, which then
  sits in an error state because the board is missing. Restart only when
  the stop line actually stopped an active Klipper, e.g. by recording that
  in a `RuntimeDirectory=` file. Both lines stay fixed in the unit file.
- **Settings path for the unit and the page:** both can rely on the
  worker's default path. If the file lives elsewhere, the unit needs an
  `Environment=KLIPPER_MCU_FLASH_CONF=…` line, and the page must use the
  same value, e.g. read from `systemctl show -p Environment`.
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
- **During a print:** `preflight` refuses.
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
- Any shell scripts go through `shellcheck` (not installed on the dev
  machine). The worker is Python: at least `python3 -m py_compile`, then
  delete `bin/__pycache__`.
- **Testing the worker on the dev machine** (no pip, no root; scratch
  directory only):
  - Klipper: clone it and check out the host's commit.
  - ARM toolchain: `apt-get download gcc-arm-none-eabi
    binutils-arm-none-eabi libnewlib-arm-none-eabi libnewlib-dev`, then
    `dpkg -x` each. The extracted gcc does not find newlib, so put a wrapper
    named `arm-none-eabi-gcc` first in `PATH` that adds
    `-L…/usr/lib/arm-none-eabi/newlib/thumb/v7-m/nofp -isystem
    …/usr/include/newlib`.
  - Board record: download the printer's klippy logs through Moonraker.
  - Klipper: a fake API socket that answers `info` and `objects/query` from
    an editable JSON file. Unix socket paths must stay under 108 bytes.
  - Venv: a stand-in `KLIPPY_ENV/bin/python` that answers `-l` from
    `board_defs.py` and fakes the flash.
  - Tested on 2026-10-02, all passing:
    - the real `skr13.config` builds and validates against the logged
      board;
    - LPC1769, no bootloader offset and UART builds are rejected;
    - every preflight and flash refusal works;
    - a tampered `.bin` and a concurrent build are refused.
- Order of work:
  1. Run `status`, `build` and `preflight` by hand on the printer host;
     none of them stops anything.
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
