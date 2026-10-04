# Multi-MCU page: two GUI mockups

Static, clickable mockups for showing several Klipper MCUs on one printer
(`[mcu]` plus `[mcu <name>]` boards). Nothing here is wired to Cockpit,
the worker or the unit. All data is fake, with placeholder serial paths,
CAN UUIDs and hostnames.

Open `option-a.html` or `option-b.html` straight from disk (`file://`).
The pages load `../../cockpit/mcu.css` for the real page's colours and
controls, so keep this folder inside the repo. Cockpit's fonts are not
reachable from disk, so the browser's fallback fonts are used.

The blue bar at the top is the mockup's own control panel. It is not part
of either design:

- **A / B** switch options and keep the scenario (it is in the URL hash).
- **Scenario:**
  1. one SKR 1.3 on USB, 41 commits behind the host (today's case);
  2. the SKR 1.3, up to date, plus a Pico on USB as `[mcu pico]`, which
     is stale;
  3. an Octopus Pro as a USB-to-CAN bridge (`can0`) with `[mcu toolhead]`
     and `[mcu ebb]` behind it. The host has just been updated and nothing
     has been flashed since, so the bridge and `toolhead` are stale and
     `ebb` is not found (its board is off). All three block Klipper.
- **Run outcome** makes the next run fail at a chosen build or flash.
- **Auto-advance / Next step** play the run, or step through it so a
  run in progress can be inspected.
- **Dark theme** toggles `pf-v6-theme-dark` on `<html>`, as `mcu.js` does.
- **Reset** restores the scenario. After a run the page keeps the new
  versions until Reset.

## Option A: tree in the status card

`option-a.html`, `option-a.js`

The current page's layout, with the "Board" line replaced by an indented
tree: host → `USB` → boards, and under a bridge → `can0` → its CAN nodes.
Each board is one row with a checkbox, its section name, board and chip,
version and commits behind, connected / not found, flash method, and the
device path or `canbus_uuid`. A red left edge and a "Blocks Klipper"
badge mark the boards that stop Klipper. Selected boards get a numbered
circle, and a "Flash order" list under the tree gives each one's reason.
The output card lists the run's steps (build each board, stop Klipper,
flash each board, start Klipper) with their state, then the final report
and the log.

- **For:** close to today's page, so the least work to build. Every fact
  about every board is visible at once, with no clicking. It reads well
  on a phone because it is just a list.
- **Against:** with three levels the tree indents a lot at 400 px. The
  "why this order" text sits under the tree, away from the rows. Rows get
  dense; a fourth or fifth board makes the card long.

## Option B: node diagram, detail panel and flash plan

`option-b.html`, `option-b.js`

An SVG diagram of the host, its buses and the boards, laid out top-down
so it stays narrow (two boxes wide for these scenarios). The colour stripe
and status line say whether a board matches the host, blocks Klipper or
is missing. Clicking a box (or Tab and Enter) fills a detail panel with
everything about that board, including what it depends on and what needs
it. A separate "Flash plan" card lists the selected boards in order with
the reason for each position, then the boards not in the plan and why.
During a run the boxes show building / flashing / done / failed, and while
the bridge flashes the CAN bus turns red and dashed ("can0 down") and its
nodes fade. The report and a collapsible log stay in the plan card.

- **For:** the dependency is drawn, not described: you see that `toolhead`
  and `ebb` hang off `mcu`'s bus, and during a run you see the bus go down.
  The plan card is a single place to decide what gets flashed. It scales
  better to more boards, because the detail lives in one panel.
- **Against:** more code (SVG layout) and more to keep accessible. Details
  need a click. At 400 px the diagram scales down to about 85 %, so its
  text is small. A wide CAN bus with four or more nodes would need
  horizontal scrolling (the wrapper allows it).

## Shared behaviour

- Default selection: every board that is present and blocks Klipper. A
  board that is not found cannot be selected.
- "Build and flash" opens an inline confirmation with the boards in
  order, the reason for each position, and warnings: the bus going down
  while its bridge flashes, boards left stale or missing (Klipper will
  still refuse to start), and that a failure stops the run.
- The run builds and checks **every** board first, with Klipper still
  running, like the current `build` then `preflight`. Only then does it
  stop Klipper, flash in order and start Klipper again. A failed build
  ends the run with Klipper untouched. A failed flash skips the remaining
  boards, still starts Klipper, and the report says which boards still
  block it.
- "Build only" runs just the build steps.

## Assumptions (not verified against Klipper's source)

These rules are working assumptions for the mockups only. Check them
before the real feature is designed.

- Klipper refuses to start while any configured MCU is missing or runs
  firmware that does not match the host. (The mockups report the first one
  as Klipper's error, but mark every such board as blocking.)
- A board reached through another board's bridge must be flashed before
  that bridge, because flashing the bridge takes the CAN bus down. The
  bridge goes last. Boards without a dependency go in settings-file order.
- In USB-to-CAN bridge mode the main board is itself addressed by
  `canbus_uuid` on `can0`, and the host sees it as a `gs_usb` interface.
- Flash methods per board: SD card (`spi_flash.py`, as today), Katapult
  over USB (for the bridge), Katapult over CAN (for CAN nodes), and the
  RP2040 boot ROM (for a Pico). Their error texts and the downtime
  estimate in the confirmation are invented.
- A board whose flash failed keeps its old firmware (true for the SD-card
  method; see open questions for Katapult).
- Each board's firmware version can be read the same way as today: from
  Klipper's `mcu <name>` status object, else klippy.log.

## Open questions

1. Which option, or which parts of each? For example option A's rows with
   option B's "CAN bus down" feedback.
2. Should the run stop at the first failure, or carry on with boards that
   do not depend on the failed one (e.g. flash `pico` even though `mcu`
   failed)?
3. If a CAN node's flash fails half-way it may be left in Katapult, with
   no Klipper firmware, so it drops off as "not found". Should the page
   offer a retry for that node, which is reached through Katapult rather
   than Klipper?
4. Is building every board before stopping Klipper right, or is the extra
   time before the flash a problem (e.g. a print could start meanwhile;
   preflight would still catch it)?
5. Should the page let you flash a board that already matches the host
   (to re-flash), or only stale ones?
6. Settings: one file per board (`KCONFIG`, `BOARD`, `DEVICE`, method)
   or one file with a section per MCU? And should the tree come from
   `printer.cfg` (Klipper's `[mcu *]` sections) or only from the
   settings?
7. Is "Blocks Klipper" the right term, or should it name Klipper's own
   error message?
8. With an absent board, should "Build and flash" still be allowed for
   the others (as in the mockups), or should the page insist the printer
   be fully on first?
