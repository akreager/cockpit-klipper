"use strict";

/* Option B: a node diagram (host, buses, boards) drawn in SVG, a detail
 * panel for the board picked in the diagram, and a separate flash plan.
 * During a run the boxes and the buses show what is happening, e.g. the
 * CAN bus going down while its bridge flashes. */

(function () {

const {M, h, s} = Mock;
const $ = id => document.getElementById(id);

const BW = 172;         // board box
const BH = 74;
const GX = 18;          // gap between boxes
const PAD = 12;
const HOST_H = 48;
const GAP = 28;         // box to bus bar, bus bar to box

function boxState(m) {
    const r = M.run;
    const st = r && r.states[m.name];
    if (r && m.via && Mock.busDown(m.via))
        return ["offline", m.link + " is down"];
    if (st && st !== "waiting")
        return [{building: "run", flashing: "run", built: "ok", done: "ok", failed: "err",
                 skipped: "muted"}[st], Mock.stateLabel(st)];
    if (!m.present)
        return ["absent", "not found"];
    if (m.behind)
        return ["err", Mock.plural(m.behind, "commit") + " behind"];
    return ["ok", "matches the host"];
}

function boardBox(m, x, y, order) {
    const [cls, text] = boxState(m);
    const n = order.indexOf(m.name);
    const pick = () => Mock.focusOn(m.name);
    return s("g", {
        class: "dg-box " + cls + (M.focus === m.name ? " focused" : ""),
        tabindex: "0", role: "button", "data-key": "box-" + m.name,
        "aria-label": Mock.section(m) + ", " + m.board + ", " + text,
        onclick: pick,
        onkeydown: e => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                pick();
            }
        },
    },
    s("rect", {class: "bg", x, y, width: BW, height: BH, rx: 10}),
    s("rect", {class: "stripe", x: x + 1, y: y + 8, width: 5, height: BH - 16, rx: 2}),
    s("text", {class: "t-name", x: x + 16, y: y + 22}, Mock.section(m)),
    s("text", {class: "t-sub", x: x + 16, y: y + 42}, m.board),
    s("text", {class: "t-stat", x: x + 16, y: y + 61}, text),
    n >= 0 ? s("g", {class: "dg-order"},
        s("circle", {cx: x + BW - 18, cy: y + 18, r: 11}),
        s("text", {x: x + BW - 18, y: y + 22, "text-anchor": "middle"}, String(n + 1))) : null);
}

function renderDiagram() {
    const order = Mock.plan().map(m => m.name);
    const pos = {};
    let cols = 0;
    const place = (m, depth) => {
        const kids = Mock.children(m.name);
        let cx;
        if (kids.length) {
            const xs = kids.map(k => place(k, depth + 1));
            cx = (xs[0] + xs[xs.length - 1]) / 2;
        } else {
            cx = PAD + cols * (BW + GX) + BW / 2;
            cols++;
        }
        pos[m.name] = {cx, y: PAD + HOST_H + 2 * GAP + depth * (BH + 2 * GAP)};
        return cx;
    };
    const rootXs = Mock.roots().map(m => place(m, 0));
    const width = Math.max(cols * (BW + GX) - GX + 2 * PAD, BW + 2 * PAD);
    const depth = Math.max(...Object.values(pos).map(p => p.y));
    const height = depth + BH + PAD;
    const hostX = (rootXs[0] + rootXs[rootXs.length - 1]) / 2;
    const parts = [];

    // A bus: down from the parent, a bar across the children, down to each.
    const bus = (fromX, fromY, kids, label, kind, down) => {
        const barY = fromY + GAP;
        const xs = kids.map(k => pos[k.name].cx);
        const cls = "dg-bus " + kind + (down ? " down" : "");
        parts.push(s("line", {class: cls, x1: fromX, y1: fromY, x2: fromX, y2: barY}));
        parts.push(s("line", {class: cls, x1: Math.min(fromX, ...xs), y1: barY,
                              x2: Math.max(fromX, ...xs), y2: barY}));
        for (const x of xs)
            parts.push(s("line", {class: cls, x1: x, y1: barY, x2: x, y2: barY + GAP}));
        parts.push(s("text", {class: "dg-bus-label" + (down ? " down" : ""),
                              x: Math.min(...xs) + 8, y: barY + 18}, label));
    };

    bus(hostX, PAD + HOST_H, Mock.roots(), "USB", "usb", false);
    for (const m of M.sc.mcus) {
        if (m.bridge) {
            const down = Mock.busDown(m.name);
            bus(pos[m.name].cx, pos[m.name].y + BH, Mock.children(m.name),
                m.bridge + (down ? " down" : " (CAN)"), "can", down);
        }
    }

    const hw = Math.min(BW + 40, width - 2 * PAD);
    parts.push(s("g", {class: "dg-host"},
        s("rect", {x: hostX - hw / 2, y: PAD, width: hw, height: HOST_H, rx: 10}),
        s("text", {class: "t-name", x: hostX, y: PAD + 20, "text-anchor": "middle"}, M.sc.host),
        s("text", {class: "t-sub", x: hostX, y: PAD + 38, "text-anchor": "middle"},
          "Klipper " + Mock.short(Mock.HOST_VERSION))));

    for (const m of M.sc.mcus)
        parts.push(boardBox(m, pos[m.name].cx - BW / 2, pos[m.name].y, order));

    const svg = $("diagram");
    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    svg.setAttribute("width", width);
    svg.setAttribute("height", height);
    svg.replaceChildren(...parts);

    const kl = Mock.klipper();
    $("summary").className = "summary " + (kl.ok ? "ok" : "warn");
    $("summary").textContent = kl.ok ? "Every board runs the host's Klipper commit."
        : "Klipper is blocked by " + Mock.blockingText(kl.blocking) + ".";
}

function renderDetail() {
    const m = Mock.mcu(M.focus);
    const kids = Mock.children(m.name);
    const blk = Mock.blocker(m);
    const fact = (k, ...v) => [h("dt", {}, k), h("dd", {}, ...v)];
    $("detail").replaceChildren(
        h("header", {class: "card-head"},
          h("h2", {}, Mock.section(m)),
          blk ? h("span", {class: "badge failed"}, "Blocks Klipper") : h("span", {class: "badge ok"}, "OK")),
        h("dl", {class: "facts detail-facts"},
          fact("Board", m.board + ", " + m.chip + (m.role ? " (" + m.role + ")" : "")),
          fact("Connection", h("span", {class: "mono"}, Mock.connection(m))),
          fact("Present", m.present ? "yes" : "no: is it switched on and cabled?"),
          fact("Firmware", m.version + ", " + Mock.behindText(m)),
          fact("Read from", m.source === "Klipper" ? "Klipper (live)" : m.source),
          fact("Flash method", Mock.METHODS[m.method].label + ". ",
               h("span", {class: "note"}, Mock.METHODS[m.method].detail)),
          fact("Build settings", h("span", {class: "mono"}, m.kconfig)),
          m.via ? fact("Depends on", m.via + ": flash this board first") : null,
          kids.length ? fact("Needed by", Mock.listText(kids.map(k => k.name)) +
                             ": flash this board last") : null),
        h("label", {class: "check"},
          h("input", {type: "checkbox", "data-key": "detail-pick", checked: M.selected.has(m.name),
                      disabled: !m.present || !!M.run, onchange: () => Mock.toggle(m.name)}),
          " Include in the flash plan"));
}

function planItem(m, n) {
    const r = M.run;
    const st = r && r.states[m.name];
    return h("li", {class: "plan-item" + (n ? "" : " out")},
        h("input", {type: "checkbox", "data-key": "plan-" + m.name, "aria-label": "Flash " + m.name,
                    checked: !!n, disabled: !m.present || !!r, onchange: () => Mock.toggle(m.name)}),
        n ? h("span", {class: "order"}, String(n)) : null,
        h("div", {class: "plan-main"},
          h("button", {class: "link name", type: "button", "data-key": "name-" + m.name,
                       onclick: () => Mock.focusOn(m.name)}, Mock.section(m)),
          h("span", {class: "note"}, " " + m.board + " · " + Mock.METHODS[m.method].label),
          h("div", {class: "plan-why"}, n ? Mock.reason(m)
            : !m.present ? "Not found: switch it on to flash it."
            : m.behind ? Mock.plural(m.behind, "commit") + " behind. Tick to flash it."
            : "Matches the host.")),
        st ? Mock.badge(st) : null);
}

function renderPlan() {
    const r = M.run;
    const plan = Mock.plan();
    $("plan").replaceChildren(...plan.map((m, i) => planItem(m, i + 1)));
    $("plan").hidden = !plan.length;
    const rest = M.sc.mcus.filter(m => !M.selected.has(m.name));
    $("others").replaceChildren(...(rest.length ? [
        h("h3", {}, plan.length ? "Not in the plan" : "No board selected"),
        h("ul", {class: "plan"}, rest.map(m => planItem(m, 0))),
    ] : []));

    $("klipper").textContent = "Klipper: " + (r ? r.klipper : Mock.klipper().text);
    const blocker = Mock.flashBlocker();
    $("plan-actions").hidden = !!r;
    $("flash").disabled = $("build-only").disabled = blocker !== null;
    $("flash").textContent = plan.length ? "Build and flash " + Mock.plural(plan.length, "board")
        : "Build and flash";
    $("action-note").textContent = blocker || "";
    $("running").hidden = !(r && !r.done && !r.buildOnly);
    const confirming = M.confirming && blocker === null;
    $("confirm").hidden = !confirming;
    if (confirming)
        $("confirm").replaceChildren(...Mock.confirmBox());

    const state = $("plan-state");
    state.hidden = !r;
    if (r) {
        state.className = "badge " + (!r.done ? "running" : r.failed ? "failed" : "ok");
        state.textContent = (r.buildOnly ? "Build " : "Run ") +
            (!r.done ? "running" : r.failed ? "failed" : "finished");
    }
    $("report").hidden = !(r && r.done);
    $("report").replaceChildren(...(r && r.done ? Mock.reportBox() : []));
    $("log-box").hidden = !r;
    $("log").replaceChildren(...Mock.logLines());
}

$("flash").addEventListener("click", () => Mock.openConfirm());
$("build-only").addEventListener("click", () => Mock.startRun(true));

Mock.init(() => {
    renderDiagram();
    renderDetail();
    renderPlan();
});

})();
