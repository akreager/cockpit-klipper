# cockpit-klipper

Build Klipper's MCU firmware from the Klipper source on your printer host and
flash it to the printer's controller board, from a
[Cockpit](https://cockpit-project.org/) page.

> **Status:** work in progress. The command-line worker and the systemd
> service work and have flashed a BTT SKR 1.3. The Cockpit page is new and
> not yet well tested.

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

## How it works

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
flashed with Klipper's own SD-card flasher (`scripts/spi_flash/`, which
`flash-sdcard.sh` runs). Other boards that
`flash-sdcard.sh` supports should work with their own Klipper config. Boards
that need another flash method (DFU, Katapult) are not covered yet.

## Install

On the printer host, as the user Klipper runs as:

```sh
git clone https://github.com/akreager/cockpit-klipper.git ~/cockpit-klipper
mkdir -p ~/printer_data/config/firmware
cp ~/klipper/.config ~/printer_data/config/firmware/my-board.config   # your board's menuconfig
cp ~/cockpit-klipper/examples/mcu-flash.conf ~/printer_data/config/firmware/   # then edit it
~/cockpit-klipper/install.sh      # installs cockpit-klipper-flash.service; asks for sudo
mkdir -p ~/.local/share/cockpit
ln -s ~/cockpit-klipper/cockpit ~/.local/share/cockpit/klipper-mcu
```

The page is *Klipper MCU* under *Tools* in Cockpit. It shows the host and
board versions, builds without flashing, and starts and follows a flash
run. Flashing needs Cockpit's administrative access, and the page reads
the run's log from the system journal, which needs membership of the
`adm` or `systemd-journal` group.

Without the page, `~/cockpit-klipper/bin/klipper-mcu-flash status` shows
where things stand. To build and flash, and follow the log until the run
ends:

```sh
t=$(date '+%F %T'); sudo systemctl start --no-block cockpit-klipper-flash.service &&
    journalctl -f -o cat -u cockpit-klipper-flash.service --since "$t" | sed '/^Run finished:/q'
```

After a flash the run waits for Klipper to come back and says which
firmware the board runs now. The last line says how the run ended, e.g.
`Run finished: success`.

## Requirements

- Klipper installed from a git checkout, with its Python virtualenv
- The toolchain for your board, e.g. `gcc-arm-none-eabi`,
  `binutils-arm-none-eabi` and `libnewlib-arm-none-eabi` for ARM boards
- Cockpit on the printer host
- For SD-card flashing: a FAT/FAT32 SD card in the board's slot

## Troubleshooting

**"Failed to Initialize SD Card. Is it inserted?"** Klipper's flasher only
says why in its debug log. The run prints the errors from that log, and the
whole log is in `~/.cache/klipper-mcu-flash/flash.log`. To try a card
without flashing, stop Klipper and run a check. It starts the card up the
same way but does not upload anything:

```sh
sudo systemctl stop klipper
~/klippy-env/bin/python ~/klipper/scripts/spi_flash/spi_flash.py -c -v \
    /dev/serial/by-id/<your board> <board name> ~/.cache/klipper-mcu-flash/out/klipper.bin
sudo systemctl start klipper
```

If the card answers but "did not come out of IDLE after reset", the card
itself is at fault: try another one (32 GB or smaller, FAT32). Otherwise
see "Failure to Initialize" in Klipper's `docs/SDCard_Updates.md`.

**"Error Uploading Firmware"** with `write error 0x..` or `could not leave
busy state after write`: the card starts up but fails while writing. Try
another card, preferably a name-brand one. The board keeps its old firmware
for now, but the failed upload can leave an incomplete `firmware.bin` on
the card, and the board's bootloader looks for that file at every reset and
power-on. Take the card out and delete the file on a computer, or replace
it with a good build (see "Flash by hand" below). If the board no longer
shows up on USB, see the next item.

**The printer is on, but the board does not show up on USB.** Neither the
page nor the service can flash it then: Klipper's SD-card flasher works
through the Klipper firmware running on the board. (With `POWER_DEVICE` set,
the page and `status` tell this apart from a printer that is switched off.)
The kernel log shows what the board does when the printer is switched on:

```sh
journalctl -k --since "10 min ago" | grep -iE "usb|cdc_acm"
```

`device descriptor read/64, error -71` and `unable to enumerate USB device`
mean that something is attached but does not answer. Check, in this order:

1. The USB cable, at both ends, or try another one.
2. Switch the printer off, take the SD card out and switch it on again.
   With no card, the bootloader just starts the firmware it has. If the board
   comes back, look at the card on a computer: a `FIRMWARE.CUR` on it means
   the bootloader flashed a `firmware.bin` from that card. Use a FAT32 card,
   preferably 32 GB or smaller.
3. **Flash by hand.** Every build that passes validation is also kept as
   `~/.cache/klipper-mcu-flash/validated.bin` (run *Build only* if there is
   none yet). The page's *Download* button saves it under the name the
   board's bootloader looks for (`firmware.bin` for most boards; while the
   board is missing, `status` prints both). Switch the printer off, copy
   that file onto the board's SD card, put the card back and switch the
   printer on. The bootloader installs it and renames it (`FIRMWARE.CUR` on
   most boards).
   Boards whose flasher converts the firmware first (MKS Robin, Chitu) need
   that converted file instead; see Klipper's `docs/SDCard_Updates.md`.

## License

GNU GPLv3, the same as Klipper and Moonraker. See [LICENSE](LICENSE).
