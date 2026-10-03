# cockpit-klipper — notes for Claude Code sessions

A Cockpit page plus a oneshot systemd service. It builds Klipper MCU firmware
from the Klipper source already installed on the printer host and flashes it
to the printer's controller board. Klipper host updates still happen in
Mainsail's Update Manager. Afterwards the tool brings the board to the same
version safely, in one click.

Status (2026-10-03): the worker `bin/klipper-mcu-flash` and the systemd
unit work on the printer host; the worker's tests also pass on the dev
machine (see "Working here"). On 2026-10-03 the unit flashed the CR-10S's
SKR 1.3 from v0.13.0-745 to v0.13.0-786, with Klipper down for 14 s (see
"The unit"). The failure paths were tested first: printer off, print
running, and a bad SD card. The Cockpit page (`cockpit/`) works in
Cockpit 362: Build only, and a Build and flash run that failed at the SD
card.
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
  - `-s` (4 MHz SPI) helps some cards that fail to initialise at the
    default 400 kHz, according to Klipper's docs. It did not help the
    CR-10S's card (2026-10-03).
- **`spi_flash.py` hides why an SD card failed to initialise** (verified
  2026-10-03). FatFS's initialise callback (`_fatfs_cb_initialize`)
  catches every exception and logs it only at debug level. Without `-v`,
  every card problem reads "Failed to Initialize SD Card. Is it
  inserted?" (`FR_NOT_READY`). The worker therefore always passes `-v`
  and prints the logged errors when a flash fails (see "The worker"). To
  test a card without flashing, stop Klipper and run `spi_flash.py -c -v
  <device> <board> <klipper.bin>` by hand. `-c` goes through the same
  reset and card start-up but does not upload.
  - The CR-10S's card answered CMD0 and CMD8, then never finished ACMD41
    ("SD Card did not come out of IDLE after reset"). `_check_command`
    tries 15 times, 0.1 s apart. That is a fault of the card itself,
    whatever the SPI speed.
  - A replacement card (120 MiB, standard capacity, FAT32) worked at the
    default 400 kHz, with both the flasher and the board's bootloader.
    It is a no-name card (CID maker 0xC8, product "APPSD", made "5/2165").
  - Later the same card failed twice while writing `firmware.bin` (15:27
    and 15:29). It started up and mounted fine, but returned garbage
    data-response tokens (`write error 0xC3`, `0x86`, `0x00`) or stayed
    busy (`could not leave busy state after write`; the flasher polls 128
    times, one USB round trip each). The board was unaffected: Klipper
    reset it after each run, its bootloader saw whatever was left on the
    card, and it still booted 786.
- **Klipper bug (at 786):** `FatFile.close()` in `spi_flash.py` logs a
  failed close with `%d` but passes the `FRESULT` name, a string. The
  resulting `TypeError` hides the close error. Not yet reported upstream.
- **Build:**
  `make -C <klipper> KCONFIG_CONFIG=<file> OUT=<dir>/ olddefconfig`, then
  the same with `-j"$(nproc)"` instead of `olddefconfig`.
  - The Makefile sets `KCONFIG_CONFIG := $(CURDIR)/.config` and `OUT=out/`;
    command-line values override both. An absolute `OUT` works (verified by
    building the SKR 1.3 config), so builds never touch `~/klipper/out`.
  - `make clean` is just `rm -rf $(OUT)`.
  - arm-none-eabi-gcc 14 prints two `-Warray-bounds` warnings for
    `src/generic/armcm_reset.c` (verified 2026-10-02). They are harmless:
    the code deliberately reads the bootloader's vector table at address 0,
    and Klipper builds with `-fno-delete-null-pointer-checks`.
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
- **Versions:** compare commits (`-g<hash>`), never version strings.
  - Both Klipper and `buildcommands.py` use `git describe --always --tags
    --long --dirty`. When that says dirty, the firmware version also gets
    `-<build time>-<hostname>` appended.
  - Klipper's host version also gets `-dirty` when `klippy/extras/` or
    `klippy/kinematics/` holds untracked or ignored `.py` files or symlinks,
    e.g. third-party extras, even though `git describe` reports the checkout
    as clean (`klippy/klippy.py`; verified 2026-10-02). `buildcommands.py`
    has no such rule, so firmware built from the same checkout is not marked
    dirty.
  - Hash abbreviations differ in length (Moonraker `g2d7717e3`, Klipper
    `g2d7717e3b`).
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
  `{"version": 0, "requires": {"cockpit": "…"}, "conditions": [{"path-exists": "…"}], "tools": {"index": {"label": "Klipper MCU"}}}`.
  The key is `requires` (as in Cockpit 362's own manifests). A menu key
  names its page: `index` is `index.html`.
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
  manifest's `requires` above what the page actually needs; the page sets
  none.
- **Theme (verified in Cockpit 362, 2026-10-03):**
  - Each of Cockpit's pages bundles PatternFly and its own copy of the theme
    code. `base1` ships only `cockpit.js` and translations.
  - The theme code sets the class `pf-v6-theme-dark` on `<html>` from
    `localStorage["shell:style"]` (`auto`, `light` or `dark`; `auto`
    follows `prefers-color-scheme`). It re-applies it on the `storage`
    event, on the shell's `cockpit-style` CustomEvent (`detail.style`) and
    on a change of `prefers-color-scheme`. `mcu.js` does the same.
  - Cockpit's fonts are in `/cockpit/static/fonts/`, i.e.
    `../../static/fonts/` from a page's CSS.
- **Admin access:** `cockpit.permission({admin: true}).allowed` says whether
  the session has administrative access. Cockpit reloads the page when that
  changes.

## Design

### Repo layout

```
README.md  LICENSE
bin/klipper-mcu-flash                worker: status | build | preflight | flash | report (written)
examples/mcu-flash.conf              every setting, with defaults                  (written)
systemd/cockpit-klipper-flash.service  unit template                              (written)
cockpit/                             the page: manifest.json index.html mcu.js mcu.css (written)
install.sh                           renders and installs the unit (uses sudo)     (written)
```

### Settings

`KEY=value` lines, documented in `examples/mcu-flash.conf`. Values are
literal (no `$VAR`; a leading `~/` is expanded) and unknown keys are an
error. The worker reads `-c FILE`, else `$KLIPPER_MCU_FLASH_CONF`, else
`~/printer_data/config/firmware/mcu-flash.conf`. For the CR-10S that file
lives in `printer-config` next to the board's kconfig
(`firmware/skr13.config`); this repo ships only the example.

### The unit (`systemd/cockpit-klipper-flash.service`)

A `Type=oneshot` template. `install.sh` fills in the Klipper user, the
worker's full path and Klipper's service name, then installs it as
`/etc/systemd/system/cockpit-klipper-flash.service`.

- **Steps:**
  1. As root, delete a leftover restart marker.
  2. As the user, `build` and then `preflight`, with Klipper still running.
     A refusal ends the run with Klipper untouched.
  3. As root, check Klipper's state:
     - `active|activating|reloading|refreshing`: create
       `/run/cockpit-klipper-flash.restart` and stop Klipper. The stop waits,
       and it also cancels a pending auto-restart.
     - `inactive|failed|maintenance`: Klipper stays stopped.
     - Anything else, e.g. `deactivating` in the middle of a restart: the run
       fails ("try again").
  4. As the user, `flash`.
  5. `ExecStopPost=` runs after success, failure and timeout alike:
     - As root, if the marker exists, delete it and run `systemctl start
       --no-block` on Klipper. So Klipper is started again only if this run
       stopped it. A Moonraker power device with `bound_services: klipper`
       keeps Klipper stopped while the plug is off, and a run must not undo
       that.
     - As the user, `report` (see "The worker"), prefixed `-`: a failing
       `ExecStopPost=` line makes systemd skip the lines after it (tested
       2026-10-03), and the next line must always run.
     - As the user, log `Run finished: $SERVICE_RESULT`.
- **Why it's built this way:**
  - **The name** must not start with `klipper` or `moonraker`. Moonraker's
    `is_service_allowed()` (`moonraker/components/machine.py`) accepts any
    service whose name starts with either, so Mainsail could start the run
    with no confirmation.
  - **The marker lives in `/run` itself, which only root can write.** A
    `RuntimeDirectory=` would be owned by `User=`, so the Klipper user could
    plant a symlink for root's `touch`.
  - **`RefuseManualStop=yes`:** `stop` and `restart` are refused, whether
    from Cockpit, the CLI or Moonraker over D-Bus, even when no run is
    active. Always use `start`; it also works from the `failed` state.
    `spi_flash.py` writes `firmware.bin` in place, so interrupting the
    upload could leave a truncated file for the bootloader.
    `systemctl kill` still works as the emergency abort, but never during
    "Uploading Klipper Firmware to SD Card". Shutdown still stops the unit.
  - **`SYSTEMD_LOG_TARGET=console`:** without it, `systemctl` in the `+`
    lines logs its errors straight to the journal, without the unit's name,
    so they are missing from `journalctl -u`. If the restart of Klipper
    fails, the line says so and the run still logs `Run finished`.
  - **`TimeoutStartSec=15min` applies to each step separately** (tested).
    `spi_flash.py` limits its own waits to a few minutes.
  - **Exec-line syntax:** a literal `$` is written `$$` in Exec lines.
    `+` lines bypass `User=` but still get `Environment=`.
  - **`PYTHONUNBUFFERED=1`** makes the flasher's progress appear in the
    journal as it happens.
  - **Settings overrides,** e.g. `Environment=KLIPPER_MCU_FLASH_CONF=`, go
    in `systemctl edit`. `install.sh` overwrites the unit file.
  - **systemd's `%h` is root's home** in system units even with `User=`, so
    `install.sh` writes out full paths.
- **`install.sh`:**
  - It refuses to run as root.
  - It accepts only plain characters in the path and names, because they
    end up unquoted in Exec lines.
  - It checks that Klipper's service exists and runs as the same user.
  - It refuses while a run is in progress. A running oneshot is
    `activating`, which `is-active` does not count as active, so it checks
    `ActiveState`.
  - It runs `daemon-reload` when systemd holds a stale copy.
- **Tested 2026-10-03** in the user manager, against a fake Klipper and a
  stub worker. Every path passed: success, a refusal at each step, a
  failed flash, a timeout, a crash-looping Klipper, a stale marker, a
  double start, and a refused stop.
- **On the printer host, 2026-10-03:** installed with `install.sh`. With
  the plug off, Moonraker had already stopped Klipper. `sudo systemctl
  start` built and validated in under 3 s, then `preflight` refused ("the
  board is not connected"). The run logged `Run finished: exit-code`, and
  Klipper stayed stopped. A blocking `systemctl start` reports such a
  refusal as "Job … failed because the control process exited with error
  code".
- **During a print, 2026-10-03:** the "print" was a one-line `G4 P60000`
  file, with no heating and no motion. `preflight`, run by hand, refused
  with "a print is running; not flashing". Klipper reported
  `print_stats.state` `printing` and `idle_timeout.state` `Printing`. Once
  the file had finished (`complete`), `preflight` passed again. It
  ran by hand rather than through the unit so that a check that wrongly
  passed could not lead to an unplanned flash. The printer-off run had
  already shown how the unit handles a refusal at that step.
- **First flash attempts, 2026-10-03:** two runs, at 400 kHz and with
  `-s`. Each time the unit stopped Klipper, and `spi_flash.py` connected,
  reset the board and reconnected. Then it failed to initialise the SD
  card (see "How flashing works"). The run ended `Run finished:
  exit-code`, and Klipper was started again after 14 s, still with the
  old firmware. Mainsail's Update Manager had moved Klipper from 756 to
  786 just before. The build of 786 validated against the board (41
  commits behind) without trouble.
- **First flash, 2026-10-03,** after the SD card was replaced:
  `sudo systemctl start` built 786 and stopped Klipper. `spi_flash.py`
  then uploaded and checked `firmware.bin` (42 KB), the bootloader
  installed it, and the dictionary check matched. Klipper started 14 s
  after it was stopped and reported `mcu_version` v0.13.0-786-g461c4e372.
  The whole run took 17 s and logged `Run finished: success`.

### The worker (`bin/klipper-mcu-flash`)

Python 3, standard library only (it needs JSON and a unix-socket client).
The printer host runs Python 3.14 since its upgrade to Ubuntu 26.04 on
2026-10-02, and the worker runs there unchanged. Exit status 1 with
`error: …` on stderr for any refusal. All output is line-buffered for the
journal and the page.

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
  - Refuses if Klipper's `HEAD` changed during the build, e.g. because
    Moonraker updated Klipper meanwhile.
  - On success it writes `BUILD_DIR/build.json` with the version, commit
    and SHA-256 of `klipper.bin` and `klipper.dict`.
- **`preflight`** (called `check-idle` in the handoff):
  - Runs **after** the build, immediately before Klipper is stopped, so a
    print started during the build cannot be cut off.
  - Requires a validated build whose files still match their hashes, that
    `DEVICE` exists ("Is the printer switched on?"; it never powers
    anything on), and that `spi_flash.py -l` knows `BOARD`. If the flasher
    itself fails, for example because the OS upgrade broke `KLIPPY_ENV`,
    it reports that error rather than an unknown board.
  - Refuses on `print_stats.state` `printing`/`paused` or
    `idle_timeout.state` `Printing`. A missing socket or a refused
    connection means Klipper is not running, which is fine. A socket that
    does not answer within 5 s is a refusal.
  - This check must live in the worker, not only in the page, because the
    unit can also be started from Cockpit's *Services* page or the CLI.
- **`flash`:** re-checks the build's hashes, refuses while Klipper answers on
  its socket, then runs `spi_flash.py -v [FLASH_ARGS] -d klipper.dict DEVICE
  BOARD klipper.bin` and exits non-zero on failure.
  - The flasher's progress (stdout) goes to the journal. Its `-v` debug log
    (stderr) goes to `BUILD_DIR/flash.log`, which also keeps the journal
    free of its noise.
  - On failure it prints each `ERROR` record of that log whose traceback
    runs through `spi_flash.py`, with the exception that handler caught
    (the last in the chain, all its lines), e.g. `error: flash_sdcard:
    error initializing sdcard (OSError: flash_sdcard: SD Card did not
    come out of IDLE after reset)`. Errors from `serialhdl.py` while the
    flasher reconnects after the reset are retries and are left out.
    Output before the first record, e.g. a crash on import or an argument
    error, counts too.
  - Before the upload it writes `BUILD_DIR/flash.json` (version, commit,
    start time, systemd's `$INVOCATION_ID`), and adds the result after.
- **`report [--timeout 60]`:** runs from `ExecStopPost=` after Klipper has
  been started again.
  - In the unit it does nothing unless `flash.json` carries this run's
    `$INVOCATION_ID`, so refusals stay quiet. systemd gives ExecStart and
    ExecStopPost lines the same ID (tested 2026-10-03). By hand it reports
    on the last flash.
  - It waits until Klipper's state is no longer `startup`, then prints the
    state and the board's `mcu_version`. After a successful flash it says
    whether that is the flashed build's commit; after a failed one, that
    the board still runs it.
  - It gives up if Klipper's service is not running after 3 s (the start
    the unit queued with `--no-block` needs a moment), or after the
    timeout. The timeout stays below systemd's default 90 s stop timeout.
  - Exit status 1 if Klipper is not ready, or the board does not run the
    build after a flash that succeeded.
- `build` and `flash` hold an flock on `BUILD_DIR/lock`, so they cannot
  overlap.
- **Not done (optional later):** send a `RESPOND` through the API
  socket's `gcode/script` so Mainsail and KlipperScreen show what happened.
- **`flash -v` and `report` (2026-10-03)** were tested in a scratch
  `BUILD_DIR` with a stand-in flasher: a card failure, a crash on import,
  success, and `report` against the real Klipper (read-only), a run that
  did not flash, a missing service and a timeout. Installed at 15:26; the
  two real runs that followed failed at the upload (see "How flashing
  works") and showed three faults, fixed since:
  - `report` called the board's firmware "the build that was flashed"
    after a failed flash, because the board already ran that commit.
  - The error list included `serialhdl.py` reconnect retries and kept only
    the last line of a two-line exception message.
  - `report` printed "Waiting for Klipper" while Klipper was stopped.

### The page (`cockpit/`)

Plain HTML, CSS and JS: no build step and no PatternFly, which Cockpit 362
ships only inside its own pages' bundles. It is installed by symlinking
`cockpit/` to `~/.local/share/cockpit/klipper-mcu`. The manifest's
`conditions` hide it until the unit is installed.

- **Worker and settings:** the page reads the unit with `systemctl show -p
  LoadState -p ExecStart -p Environment`. It runs the worker named in
  `ExecStart` (`path=`), with the unit's `KLIPPER_MCU_FLASH_CONF` if one is
  set. The page and the unit therefore always use the same worker and
  settings.
- **Status:** `status --json`, read on load, after each build and run, on
  Refresh, and every 30 s while the page is visible and idle.
- **Runs:** the page follows a run by its invocation ID, with `journalctl
  --follow --lines=all -o json _SYSTEMD_INVOCATION_ID=<id>`. That shows
  every line of the run from its start, the root lines too, and the page
  stops at `Run finished:`. It shows the first `error:` line as the reason
  for a failure.
  - It watches the unit's `ActiveState` over D-Bus. It calls
    `Manager.Subscribe` first: systemd sends property changes only while a
    client is subscribed. On each change it reads `ActiveState` and
    `InvocationID` with `systemctl show`. It shows any run it has not shown
    yet, so a run started from the CLI or Cockpit's *Services* page, or one
    in progress when the page opens, appears too.
  - On load it shows the last run. That is the unit's `InvocationID`, or,
    once systemd has unloaded a successful oneshot and forgotten it, the
    `_SYSTEMD_INVOCATION_ID` of the last `Run finished:` line
    (`journalctl --grep`, which exits 1 when nothing matches).
  - If the unit has stopped and no `Run finished:` line arrives within
    3 s, the page shows the run as "Ended".
  - Reading the system journal needs the `adm` or `systemd-journal`
    group. Allen is in `adm`.
- **Build only:** runs `build` as the logged-in user and streams its
  output. Klipper is not stopped. Closing the page kills the build, which
  is harmless: `build` deletes the previous record first.
- **Build and flash:**
  - Disabled while a run or a build is in progress, without administrative
    access, when the status could not be read, while printing, or when the
    board is absent. In that last case the page says the printer looks
    switched off and leaves it at that: no power-on button through
    Moonraker (decided 2026-10-02).
  - After an inline confirmation, the page runs `systemctl start
    --no-block cockpit-klipper-flash.service` with `superuser: "require"`.
    It then polls for up to 15 s until `InvocationID` changes.
  - While a run is in progress, a warning says not to switch the printer
    off, restart Klipper, or update or restart Moonraker.
- **Tested 2026-10-03** in Node, with a stub DOM whose `cockpit.spawn` ran
  the real commands (the root start was only logged). Passed: the status,
  the last run's log and result, the start path up to the polling, no
  admin access, the dark theme, and a real Build only. The same day Allen
  tried it in Cockpit (dark theme): Build only, and a Build and flash run
  that failed at the SD card, as expected with that card.
- **Privileges:** starting the unit uses Cockpit's administrative access.
  Optional later: a polkit rule that lets the Klipper user start just this
  unit without admin mode.

### One-time install on the printer host

```sh
git clone https://github.com/akreager/cockpit-klipper.git ~/cockpit-klipper
cp ~/klipper/.config ~/printer_data/config/firmware/<board>.config   # commit it in printer-config
~/cockpit-klipper/install.sh            # as the Klipper user; -n previews, -k names Klipper's service
ln -s ~/cockpit-klipper/cockpit ~/.local/share/cockpit/klipper-mcu
```

## Risks and failure modes

- **Wrong firmware flashed:** the board will not run Klipper. Recovery is
  to put a good build on the board's SD card as `firmware.bin` by hand,
  which means opening the printer's control box. Mitigation: validate the
  dictionary before Klipper is stopped.
- **No SD card or a bad one:** the upload fails and the old firmware
  stays. Klipper is restarted and nothing changes (verified 2026-10-03,
  with a card that would not finish initialising).
- **Klipper restarted from Mainsail or KlipperScreen mid-flash:** both
  processes want the port exclusively, so verification may fail. Re-run
  it; the firmware is usually already written. Masking Klipper during the
  run would not prevent this: `systemctl mask --runtime` has no effect on a
  unit file in `/etc/systemd/system`.
- **Printer switched on outside Moonraker** (e.g. a smart plug's own
  button): Moonraker notices only at its next status poll (`poll_interval`)
  or status request. Then it starts its `bound_services`, possibly in the
  middle of a run that found Klipper stopped, with the same effect as a
  restart from Mainsail (`process_power_changed()` in
  `moonraker/components/power.py`). Switch the printer on through
  Moonraker, or wait until Klipper is up, before flashing.
- **Stopping the run mid-upload:** refused (`RefuseManualStop=yes`).
  `systemctl kill` remains possible, and during the upload it could leave a
  truncated `firmware.bin`.
- **Moonraker restarted or updated during a run:** a power device with
  `initial_state: off` switches the printer off at every Moonraker start.
  Mid-upload, that cuts the board's power.
- **Printer switched off during a run:** the run had stopped Klipper, so
  `ExecStopPost=` starts it again, and Klipper then waits for the board.
- **Printer powered off:** the device is missing. Fail fast with a clear
  message before anything is stopped.
- **During a print:** `preflight` refuses.
- **Downtime:** Klipper is down for about 15 s per flash (14 s measured
  on the SKR 1.3, 2026-10-03). The build runs before Klipper stops.

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
     printer idle. Both tests passed on 2026-10-03, and so did the first
     real flash.
  3. Build the page last and test it in Cockpit.
  4. After the first real flash, confirm the board's `mcu_version` equals
     the host version in klippy.log or Mainsail. Done 2026-10-03: both
     v0.13.0-786-g461c4e372.
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
