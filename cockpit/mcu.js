"use strict";

/* The page for cockpit-klipper-flash.service. The unit does the work; this
 * page shows the worker's status, runs a build on its own, starts the unit
 * and follows each run in the journal. */

const UNIT = "cockpit-klipper-flash.service";
const UNIT_PATH = "/org/freedesktop/systemd1/unit/cockpit_2dklipper_2dflash_2eservice";
// A oneshot is "activating" through its ExecStartPre and ExecStart lines and
// "deactivating" while its ExecStopPost lines run.
const RUNNING = ["activating", "deactivating", "reloading", "refreshing"];
const REFRESH_MS = 30000;
// How long a run's journal may stay quiet after the unit has stopped before
// the page gives up on its "Run finished:" line.
const RUN_END_MS = 3000;

const $ = id => document.getElementById(id);

const page = {
    worker: null,           // the worker the unit runs (from its ExecStart)
    environ: [],            // the unit's KLIPPER_MCU_FLASH_CONF, if it sets one
    setupError: null,
    status: null,           // klipper-mcu-flash status --json
    statusError: null,
    unit: {state: null, invocation: null},
    knownInvocation: null,  // the last run the page has shown
    admin: null,            // administrative access; null until known
    starting: null,         // {before, deadline} until a started run shows up
    building: false,        // a build started from this page is running
    confirming: false,
    error: null,
    output: null,           // what the output card shows; see newOutput()
};

/* Follow Cockpit's light/dark setting the way Cockpit's own pages do. */

function applyTheme(style) {
    style = style || localStorage.getItem("shell:style") || "auto";
    const dark = style === "dark" || (style === "auto" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("pf-v6-theme-dark", dark);
}

window.addEventListener("storage", event => {
    if (event.key === "shell:style")
        applyTheme();
});
window.addEventListener("cockpit-style", event => {
    if (event instanceof CustomEvent)
        applyTheme(event.detail.style);
});
window.matchMedia("(prefers-color-scheme: dark)")
        .addEventListener("change", () => applyTheme());
applyTheme();

/* Helpers */

function errorText(e) {
    return String((e && (e.message || e.problem)) || e).trim();
}

function parseProps(text) {
    const props = {};
    for (const line of text.split("\n")) {
        const i = line.indexOf("=");
        if (i > 0)
            props[line.slice(0, i)] = line.slice(i + 1);
    }
    return props;
}

// Calls back with each line of a spawned process's output; resolves or
// rejects with the process.
function streamLines(proc, callback) {
    let rest = "";
    proc.stream(data => {
        const lines = (rest + data).split("\n");
        rest = lines.pop();
        lines.forEach(callback);
    });
    return proc.then(() => {
        if (rest)
            callback(rest);
    });
}

// Wraps an async function so that calls while it runs make it run once more
// afterwards, rather than overlap: every caller gets a result that started
// after its call.
function coalesce(fn) {
    let running = null;
    let again = false;
    return () => {
        if (running) {
            again = true;
            return running;
        }
        running = (async () => {
            do {
                again = false;
                await fn();
            } while (again);
            running = null;
        })();
        return running;
    };
}

function formatTime(ms) {
    return new Date(ms).toLocaleString(undefined, {dateStyle: "medium", timeStyle: "medium"});
}

function isRunning() {
    return RUNNING.includes(page.unit.state) || page.starting !== null;
}

/* The unit */

async function setup() {
    const out = await cockpit.spawn(["systemctl", "show", "-p", "LoadState", "-p", "ExecStart",
                                     "-p", "Environment", UNIT], {err: "message"});
    const props = parseProps(out);
    if (props.LoadState !== "loaded")
        throw new Error(UNIT + " is not installed. Run install.sh from cockpit-klipper.");
    // The page runs the same worker, with the same settings, as the unit.
    const worker = /path=(\S+)/.exec(props.ExecStart || "");
    if (!worker)
        throw new Error("Could not find the worker in " + UNIT + "'s ExecStart.");
    page.worker = worker[1];
    const conf = /(?:^|\s)"?(KLIPPER_MCU_FLASH_CONF=[^\s"]+)/.exec(props.Environment || "");
    page.environ = conf ? [conf[1]] : [];
}

async function readUnit() {
    const out = await cockpit.spawn(["systemctl", "show", "-p", "ActiveState",
                                     "-p", "InvocationID", UNIT], {err: "message"});
    const props = parseProps(out);
    return {state: props.ActiveState || null, invocation: props.InvocationID || null};
}

const refreshUnit = coalesce(async () => {
    try {
        page.unit = await readUnit();
    } catch (e) {
        page.error = "Could not read the state of " + UNIT + ": " + errorText(e);
    }
    const u = page.unit;
    // A run the page has not shown yet, whoever started it: show it.
    if (u.invocation && u.invocation !== page.knownInvocation) {
        page.knownInvocation = u.invocation;
        page.starting = null;
        showRun(u.invocation);
    } else if (page.output && page.output.kind === "run") {
        armRunEnd(page.output);
    }
    render();
});

function watchUnit() {
    const client = cockpit.dbus("org.freedesktop.systemd1");
    // systemd sends property changes only while some client is subscribed.
    client.call("/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager",
                "Subscribe", []).catch(() => {});
    const proxy = client.proxy("org.freedesktop.systemd1.Unit", UNIT_PATH);
    let state = null;
    proxy.addEventListener("changed", () => {
        if (proxy.valid && proxy.ActiveState !== state) {
            state = proxy.ActiveState;
            refreshUnit();
        }
    });
}

async function startRun() {
    page.confirming = false;
    page.error = null;
    try {
        const before = (await readUnit()).invocation;
        page.starting = {before, deadline: Date.now() + 15000};
        render();
        await cockpit.spawn(["systemctl", "start", "--no-block", UNIT],
                            {superuser: "require", err: "message"});
    } catch (e) {
        page.starting = null;
        page.error = "Could not start the run: " + errorText(e);
        render();
        return;
    }
    waitForRun();
}

// Polls until the run started by startRun() has an invocation ID that
// refreshUnit() has not seen.
function waitForRun() {
    if (!page.starting)
        return;
    if (Date.now() > page.starting.deadline) {
        page.starting = null;
        page.error = "The run did not start. Look for " + UNIT + " under Services.";
        render();
        return;
    }
    refreshUnit().then(() => setTimeout(waitForRun, 500));
}

/* The output card: one run or one build at a time */

function newOutput(kind) {
    const old = page.output;
    if (old) {
        clearTimeout(old.timer);
        if (old.kind === "run" && old.result === null) {
            old.closed = true;
            old.proc.close();
        }
    }
    $("log").textContent = "";
    page.output = {kind, id: null, proc: null, started: null, result: null,
                   firstError: null, timer: null, closed: false};
    return page.output;
}

function appendLine(out, text) {
    if (page.output !== out)
        return;
    const log = $("log");
    const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 20;
    const line = document.createElement("span");
    line.textContent = text + "\n";
    if (/^error: /.test(text)) {
        line.className = "error";
        if (out.firstError === null)
            out.firstError = text;
    } else if (/^warning: /.test(text)) {
        line.className = "warning";
    } else if (/^Run finished: /.test(text)) {
        line.className = "end";
    }
    log.appendChild(line);
    if (atEnd)
        log.scrollTop = log.scrollHeight;
}

function journalMessage(message) {
    if (Array.isArray(message))  // not valid UTF-8, or binary
        return new TextDecoder().decode(new Uint8Array(message));
    return message || "";
}

// Shows a run's whole log, following it until its "Run finished:" line.
function showRun(id) {
    const out = newOutput("run");
    out.id = id;
    out.proc = cockpit.spawn(["journalctl", "--follow", "--lines=all", "--output=json",
                              "--output-fields=MESSAGE", "_SYSTEMD_INVOCATION_ID=" + id],
                             {err: "message"});
    streamLines(out.proc, line => {
        if (page.output !== out || out.closed)
            return;
        let entry;
        try {
            entry = JSON.parse(line);
        } catch (e) {
            return;
        }
        if (out.started === null)
            out.started = Number(entry.__REALTIME_TIMESTAMP) / 1000;
        const text = journalMessage(entry.MESSAGE);
        appendLine(out, text);
        const end = /^Run finished: (\S+)/.exec(text);
        if (end)
            endRun(out, end[1]);
        else
            armRunEnd(out);
        render();
    }).catch(e => {
        if (page.output === out && !out.closed) {
            appendLine(out, "error: could not read the journal: " + errorText(e));
            endRun(out, null);
        }
    });
    armRunEnd(out);
    render();
}

// Once the unit has stopped, the "Run finished:" line should follow soon;
// give up on it after RUN_END_MS without any line.
function armRunEnd(out) {
    clearTimeout(out.timer);
    if (out.result === null && !isRunning())
        out.timer = setTimeout(() => endRun(out, null), RUN_END_MS);
}

function endRun(out, result) {
    if (out.closed)
        return;
    clearTimeout(out.timer);
    out.result = result || "unknown";
    out.closed = true;
    out.proc.close();
    refreshStatus();
    render();
}

async function buildOnly() {
    page.confirming = false;
    page.error = null;
    const out = newOutput("build");
    out.started = Date.now();
    page.building = true;
    render();
    out.proc = cockpit.spawn([page.worker, "build"], {err: "out", environ: page.environ});
    try {
        await streamLines(out.proc, line => appendLine(out, line));
        out.result = "success";
    } catch (e) {
        if (e.exit_status === null)
            appendLine(out, "error: " + errorText(e));
        out.result = "failed";
    }
    page.building = false;
    refreshStatus();
    render();
}

/* Status */

const refreshStatus = coalesce(async () => {
    if (!page.worker)
        return;
    try {
        const out = await cockpit.spawn([page.worker, "status", "--json"],
                                        {err: "message", environ: page.environ});
        page.status = JSON.parse(out);
        page.statusError = null;
    } catch (e) {
        page.statusError = errorText(e);
    }
    render();
});

// The most recent run, when systemd has already forgotten it: it unloads a
// oneshot that succeeded.
async function showLastRun() {
    let out;
    try {
        out = await cockpit.spawn(["journalctl", "--unit=" + UNIT, "--output=json", "--lines=1",
                                   "--grep=^Run finished:",
                                   "--output-fields=MESSAGE,_SYSTEMD_INVOCATION_ID"],
                                  {err: "message"});
    } catch (e) {
        if (e.exit_status !== 1)  // 1: no run at all
            page.error = "Could not read the journal: " + errorText(e);
        return;
    }
    const lines = out.trim().split("\n");
    const id = JSON.parse(lines[lines.length - 1])._SYSTEMD_INVOCATION_ID;
    if (id && !page.output) {
        page.knownInvocation = id;
        showRun(id);
    }
}

/* Rendering */

function boardText(board) {
    if (!board.version)
        return "unknown: Klipper has not reported it and klippy.log has no record";
    let text = board.version + (board.source === "klipper" ? " (reported by Klipper)"
        : " (from " + board.source + ")");
    const {behind, ahead} = board;
    if (behind === null || ahead === null)
        text += ", commit not found in the host's checkout";
    else if (behind && ahead)
        text += ", " + behind + " behind and " + ahead + " ahead of the host";
    else if (behind)
        text += ", " + behind + (behind === 1 ? " commit" : " commits") + " behind the host";
    else if (ahead)
        text += ", " + ahead + (ahead === 1 ? " commit" : " commits") + " ahead of the host";
    return text;
}

function summary(st) {
    const b = st.board;
    if (!b.version)
        return ["warn", "The board's firmware version is not known."];
    if (b.behind === null || b.ahead === null)
        return ["warn", "The board's commit is not in the host's Klipper checkout."];
    if (b.behind || b.ahead)
        return ["warn", "The board's firmware does not match the host's Klipper."];
    return ["ok", "The board runs the same Klipper commit as the host."];
}

function klipperText(kl) {
    if (kl.error)
        return kl.error;
    if (!kl.running)
        return "not running (service " + (kl.service || "unknown") + ")";
    let text = kl.state || "unknown";
    if (kl.state !== "ready" && kl.state_message)
        text += " (" + kl.state_message.trim().split("\n")[0] + ")";
    return text + ", print " + (kl.print_state || "unknown");
}

function renderStatus() {
    const st = page.status;
    $("status-error").hidden = !page.statusError;
    $("status-error").textContent = page.statusError || "";
    if (!st) {
        $("summary").textContent = page.statusError ? "" : "Reading status…";
        return;
    }
    const [kind, text] = summary(st);
    $("summary").className = "summary " + kind;
    $("summary").textContent = text;
    $("host").textContent = st.host.version || "unknown (is KLIPPER_DIR a git checkout?)";
    $("board").textContent = boardText(st.board);
    $("device").textContent = st.board.present ? "connected"
        : "not found: is the printer switched on?";
    $("device").title = st.board.device;
    $("klipper").textContent = klipperText(st.klipper);
    const build = st.build;
    $("build").textContent = !build ? "none"
        : build.version + ", validated " + build.built.replace("T", " ") +
          (build.commit === st.host.commit ? "" : " (not the host's current commit)");
    $("settings").textContent = st.settings;
}

// Why "Build and flash" cannot run now, or null.
function flashBlocker() {
    const st = page.status;
    if (!page.worker)
        return "The flash service is not set up.";
    if (isRunning())
        return "A flash run is in progress.";
    if (page.building)
        return "A build is running.";
    if (page.admin === false)
        return "Flashing needs administrative access (see Cockpit's top bar).";
    if (page.statusError)
        return "The status could not be read.";
    if (!st)
        return "Reading status…";
    if (!st.board.present)
        return "The printer looks switched off.";
    if (["printing", "paused"].includes(st.klipper.print_state) ||
            st.klipper.idle_state === "Printing")
        return "A print is running.";
    return null;
}

function renderActions() {
    const blocker = flashBlocker();
    $("flash").disabled = blocker !== null;
    $("build-only").disabled = !page.worker || isRunning() || page.building;
    $("action-note").textContent = blocker || "";
    $("running").hidden = !isRunning();
    $("setup-error").hidden = !page.setupError;
    $("setup-error").textContent = page.setupError || "";
    $("page-error").hidden = !page.error;
    $("page-error").textContent = page.error || "";

    const confirming = page.confirming && blocker === null;
    $("confirm").hidden = !confirming;
    if (confirming) {
        const st = page.status;
        let text = "This builds " + (st.host.version || "the host's Klipper");
        // The unit stops and restarts Klipper only if it is running.
        if (["active", "activating", "reloading", "refreshing"].includes(st.klipper.service))
            text += ", stops Klipper, flashes the board and starts Klipper again. " +
                "Klipper is down for about 15 seconds.";
        else
            text += " and flashes the board. Klipper is not running and stays stopped.";
        if (st.board.behind === 0 && st.board.ahead === 0)
            text += " The board already runs this commit.";
        $("confirm-text").textContent = text;
    }
}

const RESULTS = {
    success: ["ok", "Succeeded"],
    failed: ["failed", "Failed"],
    "exit-code": ["failed", "Failed"],
    unknown: ["unknown", "Ended"],
};

function renderOutput() {
    const out = page.output;
    const state = $("output-state");
    const note = $("output-summary");
    $("log").hidden = !out;
    if (!out) {
        $("output-title").textContent = "Output";
        state.hidden = true;
        return;
    }
    let title = out.kind === "run" ? "Flash run" : "Build only (nothing flashed)";
    if (out.started !== null)
        title += ", " + formatTime(out.started);
    $("output-title").textContent = title;

    state.hidden = false;
    let kind, label;
    if (out.result === null)
        [kind, label] = ["running", out.kind === "run" ? "Running" : "Building"];
    else
        [kind, label] = RESULTS[out.result] || ["failed", "Failed (" + out.result + ")"];
    state.className = "badge " + kind;
    state.textContent = label;

    note.className = "note";
    note.textContent = "";
    if (out.result === "unknown") {
        note.textContent = "The run's log ended without a \"Run finished\" line.";
    } else if (out.result !== null && out.result !== "success" && out.firstError) {
        note.className = "note failed";
        note.textContent = out.firstError;
    }
    note.hidden = !note.textContent;
}

function render() {
    renderStatus();
    renderActions();
    renderOutput();
}

/* Start */

async function init() {
    $("refresh").addEventListener("click", () => {
        page.error = null;
        refreshUnit();
        refreshStatus();
    });
    $("flash").addEventListener("click", () => {
        page.confirming = true;
        render();
        $("confirm-cancel").focus();
    });
    $("confirm-cancel").addEventListener("click", () => {
        page.confirming = false;
        render();
    });
    $("confirm-flash").addEventListener("click", startRun);
    $("build-only").addEventListener("click", buildOnly);

    const permission = cockpit.permission({admin: true});
    page.admin = permission.allowed;
    permission.addEventListener("changed", () => {
        page.admin = permission.allowed;
        render();
    });

    try {
        await setup();
    } catch (e) {
        page.setupError = errorText(e);
        render();
        return;
    }
    watchUnit();
    await refreshUnit();
    if (!page.output)
        await showLastRun();
    await refreshStatus();

    setInterval(() => {
        if (cockpit.hidden)
            return;
        refreshUnit();
        if (!isRunning() && !page.building)
            refreshStatus();
    }, REFRESH_MS);
    cockpit.addEventListener("visibilitychange", () => {
        if (!cockpit.hidden && !isRunning() && !page.building)
            refreshStatus();
    });
}

init();
