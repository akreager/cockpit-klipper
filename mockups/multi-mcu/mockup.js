"use strict";

/* Shared by option-a.html and option-b.html: sample data, the ordering
 * rules, a pretend run, the theme toggle and the mockup toolbar. Nothing
 * here talks to Cockpit, Klipper or systemd, and every value is made up.
 * The ordering and flash-method rules are working assumptions that have
 * not been checked against Klipper's source (see README.md). */

window.Mock = (function () {

const HOST_VERSION = "v0.13.0-786-g461c4e372";
const OLD_VERSION = "v0.13.0-745-g3f0e9a1b7";
const STEP_MS = 900;

const METHODS = {
    sdcard: {
        label: "SD card",
        detail: "spi_flash.py writes firmware.bin to the board's SD card; " +
                "the bootloader installs it when the board resets.",
        seconds: 15,
        error: "flash_sdcard: SD Card did not come out of IDLE after reset",
    },
    "katapult-usb": {
        label: "Katapult over USB",
        detail: "Katapult's flashtool.py asks the running firmware to enter " +
                "the bootloader, then uploads over the USB port it reappears on.",
        seconds: 10,
        error: "no Katapult device appeared on USB after the reboot request",
    },
    "katapult-can": {
        label: "Katapult over CAN",
        detail: "Katapult's flashtool.py -i <bus> -u <uuid> reboots the node " +
                "into its bootloader and uploads over the CAN bus.",
        seconds: 10,
        error: "no answer from Katapult on the CAN bus after the reboot request",
    },
    rp2040: {
        label: "RP2040 boot ROM",
        detail: "Reboots the RP2040 into its USB boot ROM and loads the image " +
                "with Klipper's rp2040 flash tool (what make flash does).",
        seconds: 10,
        error: "no RP2040 boot device appeared after the reboot request",
    },
};

const SKR = {
    name: "mcu", board: "BTT SKR 1.3", chip: "LPC1768", link: "USB",
    device: "/dev/serial/by-id/usb-Klipper_lpc1768_XXXXXXXX-if00",
    present: true, source: "Klipper", method: "sdcard",
    kconfig: "firmware/skr13.config",
};

// via: the MCU whose bridge the board is reached through; bridge: the bus
// a board provides. Boards without via hang off the host's USB.
const SCENARIOS = [{
    id: "usb",
    label: "1. One board on USB",
    host: "printer-host",
    mcus: [Object.assign({}, SKR, {version: OLD_VERSION, behind: 41})],
}, {
    id: "pico",
    label: "2. Main board and a Pico on USB",
    host: "printer-host",
    mcus: [
        Object.assign({}, SKR, {version: HOST_VERSION, behind: 0}),
        {
            name: "pico", board: "Raspberry Pi Pico", chip: "RP2040",
            link: "USB", role: "ADXL345 accelerometer",
            device: "/dev/serial/by-id/usb-Klipper_rp2040_XXXXXXXXXXXXXXXX-if00",
            present: true, source: "Klipper", method: "rp2040",
            kconfig: "firmware/pico.config", version: OLD_VERSION, behind: 41,
        },
    ],
}, {
    id: "can",
    label: "3. USB-to-CAN bridge with two CAN nodes",
    host: "printer-host",
    mcus: [{
        name: "mcu", board: "BTT Octopus Pro", chip: "STM32H723",
        link: "USB", bridge: "can0", uuid: "0123456789ab",
        device: "can0 (USB-to-CAN bridge, gs_usb)",
        present: true, source: "Klipper", method: "katapult-usb",
        kconfig: "firmware/octopus.config", version: OLD_VERSION, behind: 41,
    }, {
        name: "toolhead", board: "BTT EBB36", chip: "STM32G0B1",
        link: "can0", via: "mcu", uuid: "a1b2c3d4e5f6",
        present: true, source: "Klipper", method: "katapult-can",
        kconfig: "firmware/ebb36.config", version: OLD_VERSION, behind: 41,
    }, {
        name: "ebb", board: "BTT EBB42", chip: "STM32G0B1",
        link: "can0", via: "mcu", uuid: "f6e5d4c3b2a1",
        present: false, source: "klippy.log.2026-10-01", method: "katapult-can",
        kconfig: "firmware/ebb42.config", version: OLD_VERSION, behind: 41,
    }],
}];

const M = {
    sc: null,               // a working copy of the scenario
    selected: new Set(),    // names of the boards to flash
    confirming: false,
    run: null,              // see startRun()
    focus: null,            // the board option B shows in its detail panel
    outcome: "success",     // "success", "build:<name>" or "flash:<name>"
    auto: true,
    timer: null,
    renderFn: null,
};

const clone = x => JSON.parse(JSON.stringify(x));
const plural = (n, word) => n + " " + word + (n === 1 ? "" : "s");

function listText(names) {
    if (names.length < 2)
        return names.join("");
    return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
}

/* Small DOM helpers */

function fill(el, props, kids) {
    for (const [k, v] of Object.entries(props || {})) {
        if (v === null || v === undefined || v === false)
            continue;
        if (k === "class")
            el.setAttribute("class", v);
        else if (k.startsWith("on"))
            el.addEventListener(k.slice(2), v);
        else
            el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat(Infinity)) {
        if (kid !== null && kid !== undefined && kid !== false)
            el.append(kid instanceof Node ? kid : String(kid));
    }
    return el;
}

const h = (tag, props, ...kids) => fill(document.createElement(tag), props, kids);
const s = (tag, props, ...kids) =>
    fill(document.createElementNS("http://www.w3.org/2000/svg", tag), props, kids);

/* The tree and its rules */

const mcu = name => M.sc.mcus.find(m => m.name === name);
const children = name => M.sc.mcus.filter(m => m.via === name);
const roots = () => M.sc.mcus.filter(m => !m.via);
const section = m => m.name === "mcu" ? "[mcu]" : "[mcu " + m.name + "]";
const short = version => version.replace(/-g[0-9a-f]+$/, "");

// Why the board stops Klipper from starting, or null. Assumption: Klipper
// refuses to start while any board is missing or runs other firmware.
function blocker(m) {
    if (!m.present)
        return "not found";
    if (m.behind)
        return plural(m.behind, "commit") + " behind";
    return null;
}

function behindText(m) {
    return m.behind ? plural(m.behind, "commit") + " behind the host" : "matches the host";
}

function connection(m) {
    if (m.via)
        return "CAN node on " + m.link + " through " + m.via + "'s bridge, canbus_uuid " + m.uuid;
    if (m.bridge)
        return "USB, provides " + m.bridge + " as a USB-to-CAN bridge, canbus_uuid " + m.uuid;
    return "USB serial " + m.device;
}

// Boards behind a bridge come before the bridge (depth first); otherwise
// the order of the settings file.
function plan() {
    const out = [];
    const visit = m => {
        children(m.name).forEach(visit);
        if (M.selected.has(m.name))
            out.push(m);
    };
    roots().forEach(visit);
    return out;
}

function reason(m) {
    if (m.bridge)
        return "Last: flashing " + m.name + " takes " + m.bridge + " down, and " +
            listText(children(m.name).map(k => k.name)) + " can only be reached through it.";
    if (m.via)
        return "Before " + m.via + ": it is reached through " + m.via + "'s " +
            mcu(m.via).bridge + " bridge.";
    if (M.sc.mcus.length === 1)
        return "The only board.";
    return "No dependency on the other boards: settings-file order.";
}

function klipper() {
    const blocking = M.sc.mcus.filter(blocker);
    if (!blocking.length)
        return {ok: true, text: "ready", blocking};
    const first = blocking[0];
    const msg = first.present ? "MCU '" + first.name + "' protocol error"
        : "mcu '" + first.name + "': Unable to connect";
    return {ok: false, text: "error (" + msg + ")", blocking};
}

function blockingText(blocking) {
    return listText(blocking.map(m => m.name + " (" + blocker(m) + ")"));
}

// Why "Build and flash" cannot run now, or null.
function flashBlocker() {
    if (M.run && !M.run.done)
        return "A run is in progress.";
    if (M.run)
        return "Close the finished run first.";
    if (!plan().length)
        return "Select at least one board.";
    return null;
}

function confirmModel() {
    const steps = plan();
    const secs = steps.reduce((sum, m) => sum + METHODS[m.method].seconds, 0) + 5;
    const intro = "This builds " + plural(steps.length, "firmware image") + " from " +
        HOST_VERSION + " and checks each against its board while Klipper still runs. " +
        "Then it stops Klipper, flashes the boards in this order and starts Klipper " +
        "again. Klipper is down for roughly " + secs + " seconds (a guess).";
    const warnings = [];
    for (const m of steps) {
        if (m.bridge)
            warnings.push("While " + m.name + " flashes, " + m.bridge + " is down and " +
                listText(children(m.name).map(k => k.name)) + " drop off the bus.");
    }
    for (const m of M.sc.mcus) {
        if (M.selected.has(m.name) || !blocker(m))
            continue;
        warnings.push(m.present
            ? m.name + " stays " + blocker(m) + " the host, so Klipper will still refuse to start."
            : m.name + " is not found and cannot be flashed, so Klipper will still refuse to start.");
    }
    warnings.push("A failure stops the run. Boards after it keep their old firmware.");
    return {intro, steps: steps.map(m => ({m, reason: reason(m)})), warnings};
}

/* A pretend run: build every board with Klipper running, then stop
 * Klipper, flash in plan order and start Klipper again. */

const STATES = {
    waiting: ["waiting", "idle"],
    building: ["building", "running"],
    built: ["built", "ok"],
    flashing: ["flashing", "running"],
    done: ["done", "ok"],
    failed: ["failed", "failed"],
    skipped: ["skipped", "unknown"],
    running: ["running", "running"],
};
const stateLabel = st => STATES[st][0];
const stateClass = st => STATES[st][1];

function stepLabel(step) {
    return {
        build: "Build and check " + step.mcu,
        stop: "Check no print runs, stop Klipper",
        flash: "Flash " + step.mcu,
        start: "Start Klipper, report",
    }[step.kind];
}

function log(text, kind) {
    M.run.log.push({text, kind: kind || ""});
}

function startRun(buildOnly) {
    const names = plan().map(m => m.name);
    const steps = names.map(n => ({kind: "build", mcu: n}));
    if (!buildOnly) {
        steps.push({kind: "stop"});
        names.forEach(n => steps.push({kind: "flash", mcu: n}));
        steps.push({kind: "start"});
    }
    M.run = {
        buildOnly, steps, i: 0, started: false, done: false, failed: null,
        states: Object.fromEntries(names.map(n => [n, "waiting"])),
        stepStates: steps.map(() => "waiting"),
        before: Object.fromEntries(M.sc.mcus.map(m => [m.name, m.version])),
        klipper: klipper().text,
        log: [],
    };
    M.confirming = false;
    log((buildOnly ? "Build only: " : "Run started: ") + names.join(", "));
    render();
    schedule();
}

function beginStep(step) {
    const r = M.run;
    r.stepStates[r.i] = "running";
    const m = step.mcu && mcu(step.mcu);
    if (step.kind === "build") {
        r.states[m.name] = "building";
        log("== " + m.name + ": building " + HOST_VERSION + " for " + m.board +
            " from " + m.kconfig);
    } else if (step.kind === "stop") {
        log("Preflight: no print is running; every board in the plan is present");
        log("Stopping klipper.service");
        r.klipper = "stopping";
    } else if (step.kind === "flash") {
        r.states[m.name] = "flashing";
        log("== " + m.name + ": flashing with " + METHODS[m.method].label + " (" +
            (m.uuid ? "canbus_uuid " + m.uuid : m.device) + ")");
        if (m.bridge)
            log(m.bridge + " is down until " + m.name + " is back", "warning");
    } else {
        log("Starting klipper.service");
        r.klipper = "starting";
    }
}

function endStep(step) {
    const r = M.run;
    const m = step.mcu && mcu(step.mcu);
    if (step.kind !== "stop" && step.kind !== "start" &&
            M.outcome === step.kind + ":" + step.mcu)
        return failStep(step, m);
    r.stepStates[r.i] = "done";
    if (step.kind === "build") {
        r.states[m.name] = "built";
        log(m.name + ": klipper.bin matches the board (MCU " + m.chip + ", comms " +
            m.link + ")");
    } else if (step.kind === "stop") {
        log("klipper.service stopped");
        r.klipper = "stopped by this run";
    } else if (step.kind === "flash") {
        r.states[m.name] = "done";
        Object.assign(m, {version: HOST_VERSION, behind: 0, source: "Klipper"});
        log(m.name + ": flash complete, the board's data dictionary matches");
    } else {
        r.klipper = klipper().text;
        log("Klipper: " + r.klipper);
    }
    r.i++;
    if (r.i >= r.steps.length)
        finish();
}

function failStep(step, m) {
    const r = M.run;
    r.failed = step;
    r.stepStates[r.i] = "failed";
    r.states[m.name] = "failed";
    log("error: " + m.name + ": " + (step.kind === "build"
        ? "the build's MCU constants do not match the board (CLOCK_FREQ)"
        : METHODS[m.method].error), "error");
    for (const n of Object.keys(r.states)) {
        if (["waiting", "built"].includes(r.states[n]))
            r.states[n] = "skipped";
    }
    // Klipper is started again only if this run stopped it.
    const startAt = step.kind === "flash" ? r.steps.findIndex(x => x.kind === "start") : -1;
    for (let i = r.i + 1; i < r.steps.length; i++)
        r.stepStates[i] = i === startAt ? "waiting" : "skipped";
    if (step.kind === "flash")
        log(m.name + " still runs its old firmware", "warning");
    r.i = startAt < 0 ? r.steps.length : startAt;
    if (startAt < 0)
        finish();
}

function finish() {
    const r = M.run;
    r.done = true;
    if (!r.failed && !r.stepStates.includes("waiting"))
        r.klipper = klipper().text;
    log("Run finished: " + (r.failed ? "exit-code" : "success"), r.failed ? "error end" : "end");
}

function tick() {
    const r = M.run;
    if (!r || r.done)
        return;
    const step = r.steps[r.i];
    if (r.started)
        endStep(step);
    else
        beginStep(step);
    r.started = !r.started;
    render();
}

function schedule() {
    clearTimeout(M.timer);
    if (M.auto && M.run && !M.run.done)
        M.timer = setTimeout(() => { tick(); schedule(); }, STEP_MS);
}

function reportModel() {
    const r = M.run;
    const kl = klipper();
    const rows = M.sc.mcus.map(m => ({
        m, before: r.before[m.name], after: m.version,
        result: r.states[m.name] || null, blocks: blocker(m),
    }));
    let headline;
    if (r.failed && r.failed.kind === "build")
        headline = "Stopped at “" + stepLabel(r.failed) + "”. Nothing was flashed" +
            (r.buildOnly ? "." : " and Klipper was not stopped.");
    else if (r.failed)
        headline = "Stopped at “" + stepLabel(r.failed) + "”. Boards after it were " +
            "skipped and keep their old firmware.";
    else if (r.buildOnly)
        headline = "Built and checked " + plural(rows.filter(x => x.result).length, "image") +
            ". Nothing was flashed.";
    else
        headline = "Flashed " + plural(rows.filter(x => x.result === "done").length, "board") + ".";
    const klipperLine = kl.ok ? "Klipper is ready: every board runs the host's commit."
        : "Klipper still refuses to start: blocked by " + blockingText(kl.blocking) + ".";
    return {ok: !r.failed, headline, rows, klipperLine, klipperOk: kl.ok};
}

/* Actions the options call */

function defaultSelection() {
    M.selected = new Set(M.sc.mcus.filter(m => m.present && blocker(m)).map(m => m.name));
}

function load(id) {
    clearTimeout(M.timer);
    const sc = SCENARIOS.find(x => x.id === id) || SCENARIOS[0];
    M.sc = clone(sc);
    M.run = null;
    M.confirming = false;
    defaultSelection();
    M.focus = (M.sc.mcus.find(blocker) || M.sc.mcus[0]).name;
    $("mock-scenario").value = M.sc.id;
    for (const a of document.querySelectorAll(".mock-bar a"))
        a.hash = M.sc.id;
    try {
        if (location.hash !== "#" + M.sc.id)
            history.replaceState(null, "", "#" + M.sc.id);
    } catch (e) { /* some browsers refuse this on file:// */ }
    render();
}

function toggle(name) {
    if (M.run)
        return;
    if (M.selected.has(name))
        M.selected.delete(name);
    else if (mcu(name).present)
        M.selected.add(name);
    M.confirming = false;
    render();
}

function closeRun() {
    clearTimeout(M.timer);
    M.run = null;
    defaultSelection();
    render();
}

/* Pieces both options show the same way */

const badge = st => h("span", {class: "badge " + stateClass(st)}, stateLabel(st));

function confirmBox() {
    const c = confirmModel();
    return [
        h("p", {}, c.intro),
        h("ol", {class: "confirm-order"}, c.steps.map(({m, reason: why}) =>
            h("li", {}, h("strong", {}, m.name), " (" + m.board + ", " +
              METHODS[m.method].label + "). ", why))),
        h("ul", {class: "confirm-warn"}, c.warnings.map(w => h("li", {}, w))),
        h("div", {class: "actions"},
          h("button", {class: "danger", type: "button", "data-key": "confirm-flash",
                       onclick: () => startRun(false)},
            "Flash " + plural(c.steps.length, "board")),
          h("button", {class: "secondary", type: "button", "data-key": "confirm-cancel",
                       onclick: () => { M.confirming = false; render(); }}, "Cancel")),
    ];
}

function reportBox() {
    const r = reportModel();
    const head = ["Board", "Before", "Now", "This run", "Klipper"];
    return [
        h("p", {class: "report-head " + (r.ok ? "ok" : "failed")}, r.headline),
        h("div", {class: "table-wrap"}, h("table", {class: "report"},
          h("thead", {}, h("tr", {}, head.map(t => h("th", {scope: "col"}, t)))),
          h("tbody", {}, r.rows.map(row => h("tr", {},
            h("th", {scope: "row"}, section(row.m)),
            h("td", {}, short(row.before)),
            h("td", {}, short(row.after)),
            h("td", {}, row.result ? badge(row.result) : h("span", {class: "note"}, "not in run")),
            h("td", {class: row.blocks ? "err" : "ok"},
              row.blocks ? "blocks: " + row.blocks : "OK")))))),
        h("p", {class: "report-klipper " + (r.klipperOk ? "ok" : "err")}, r.klipperLine),
        h("div", {class: "actions"}, h("button", {class: "secondary", type: "button",
            "data-key": "close-run", onclick: closeRun}, "Back to status")),
    ];
}

function logLines() {
    return M.run ? M.run.log.map(l => h("span", {class: l.kind || null}, l.text + "\n")) : [];
}

/* Toolbar, theme and rendering */

const $ = id => document.getElementById(id);

function applyTheme(dark) {
    document.documentElement.classList.toggle("pf-v6-theme-dark", dark);
    $("mock-theme").textContent = dark ? "Light theme" : "Dark theme";
    try {
        localStorage.setItem("mockup:style", dark ? "dark" : "light");
    } catch (e) { /* file:// may refuse storage */ }
}

function storedDark() {
    let style = null;
    try {
        style = localStorage.getItem("mockup:style");
    } catch (e) { /* ignore */ }
    if (style)
        return style === "dark";
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function renderOutcomes() {
    const sel = $("mock-outcome");
    const opts = [["success", "Every step succeeds"]];
    for (const m of plan())
        opts.push(["build:" + m.name, "Build of " + m.name + " fails"]);
    for (const m of plan())
        opts.push(["flash:" + m.name, "Flash of " + m.name + " fails"]);
    const key = opts.map(o => o[0]).join();
    if (sel.dataset.key !== key) {
        sel.replaceChildren(...opts.map(([v, t]) => h("option", {value: v}, t)));
        sel.dataset.key = key;
        if (!opts.some(o => o[0] === M.outcome))
            M.outcome = "success";
        sel.value = M.outcome;
    }
    sel.disabled = !!M.run;
    $("mock-step").disabled = !M.run || M.run.done;
}

function render() {
    const active = document.activeElement;
    const key = active && active.dataset ? active.dataset.key : null;
    renderOutcomes();
    M.renderFn();
    if (key) {
        const el = document.querySelector('[data-key="' + key + '"]');
        if (el)
            el.focus();
    }
}

function init(renderFn) {
    M.renderFn = renderFn;
    const sel = $("mock-scenario");
    sel.replaceChildren(...SCENARIOS.map(x => h("option", {value: x.id}, x.label)));
    sel.addEventListener("change", () => load(sel.value));
    $("mock-outcome").addEventListener("change", e => { M.outcome = e.target.value; });
    $("mock-auto").addEventListener("change", e => { M.auto = e.target.checked; schedule(); });
    $("mock-step").addEventListener("click", () => { clearTimeout(M.timer); tick(); schedule(); });
    $("mock-reset").addEventListener("click", () => load(M.sc.id));
    $("mock-theme").addEventListener("click", () =>
        applyTheme(!document.documentElement.classList.contains("pf-v6-theme-dark")));
    applyTheme(storedDark());
    window.addEventListener("hashchange", () => load(location.hash.slice(1)));
    load(location.hash.slice(1));
}

return {
    M, METHODS, HOST_VERSION, h, s, plural, listText,
    mcu, children, roots, section, short, blocker, behindText, connection,
    plan, reason, klipper, blockingText, flashBlocker, confirmModel, reportModel,
    stepLabel, stateLabel, stateClass, badge, confirmBox, reportBox, logLines, toggle, startRun, closeRun, render, init,
    openConfirm() { M.confirming = true; render(); },
    cancelConfirm() { M.confirming = false; render(); },
    focusOn(name) { M.focus = name; render(); },
    busDown: bridge => !!(M.run && M.run.states[bridge] === "flashing"),
};

})();
