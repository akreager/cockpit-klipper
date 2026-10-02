# cockpit-klipper

Build Klipper's MCU firmware from the Klipper source on your printer host and
flash it to the printer's controller board, from a
[Cockpit](https://cockpit-project.org/) page.

> **Status:** design stage. There is nothing to install yet.

## Why

When Klipper's host software is updated (for example from Mainsail's Update
Manager), the firmware on the printer's board falls behind. Sooner or later
Klipper stops with an MCU protocol error until the board is rebuilt and
reflashed.

This tool does that in one click, outside Klipper:

- Flashing needs the board's serial port to itself, so Klipper has to be
  stopped. A Klipper macro cannot safely stop the process it runs in.
- Macros cannot run at all while Klipper is in an error state, which is
  exactly when a flash is needed.

## How it will work

- **A oneshot systemd service does the work.** It builds the firmware as
  your user while Klipper is still running, checks the build against the
  firmware that is running now, refuses if a print is active or the board is
  missing, stops Klipper, flashes, and starts Klipper again, also after a
  failure. Because it is a service, closing the browser tab mid-flash does
  not interrupt it.
- **The Cockpit page is only the UI.** It shows the host and board versions,
  runs a build on its own, starts the service and streams its log.
- **Root runs only the fixed `systemctl stop/start klipper` lines** of the
  installed unit file. The build and the flash run as your user.
- **It never updates Klipper itself.** It builds from whatever Klipper
  source is installed; host updates stay in your usual update tool.

## Boards

The first target is the BTT SKR 1.3 (LPC1768) with its SD-card bootloader,
flashed with Klipper's own `scripts/flash-sdcard.sh`. Other boards that
`flash-sdcard.sh` supports should work with their own Klipper config. Boards
that need another flash method (DFU, Katapult) are not covered yet.

## Requirements

- Klipper installed from a git checkout, with its Python virtualenv
- The toolchain for your board, e.g. `gcc-arm-none-eabi`,
  `binutils-arm-none-eabi` and `libnewlib-arm-none-eabi` for ARM boards
- Cockpit on the printer host
- For SD-card flashing: a FAT/FAT32 SD card in the board's slot

## License

GNU GPLv3, the same as Klipper and Moonraker. See [LICENSE](LICENSE).
