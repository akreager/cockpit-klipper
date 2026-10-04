"use strict";

/* Option A: the boards as an indented tree inside the status card
 * (host, then bus, then board), one row per board with a checkbox. The
 * flash order is numbered on the rows and spelt out under the tree. The
 * output card follows the run step by step, with the log below. */

(function () {

const {M, h} = Mock;
const $ = id => document.getElementById(id);

function busItem(label, note, boards, order) {
    return h("li", {class: "bus"},
        h("div", {class: "row bus-row"},
          h("span", {class: "bus-name"}, label), note ? h("span", {class: "note"}, note) : null),
        h("ul", {}, boards.map(m => boardItem(m, order))));
}

function boardItem(m, order) {
    const r = M.run;
    const n = order.indexOf(m.name);
    const blk = Mock.blocker(m);
    const st = r && r.states[m.name];
    let side;
    if (st)
        side = Mock.badge(st);
    else if (r)
        side = h("span", {class: "note"}, "not in run");
    else
        side = blk ? h("span", {class: "badge failed"}, "Blocks Klipper")
            : h("span", {class: "badge ok"}, "OK");

    const row = h("div", {class: "row mcu-row" + (blk ? " blocking" : "") + (m.present ? "" : " absent")},
        h("input", {
            type: "checkbox", "data-key": "pick-" + m.name, "aria-label": "Flash " + m.name,
            checked: M.selected.has(m.name), disabled: !m.present || !!r,
            onchange: () => Mock.toggle(m.name),
        }),
        h("div", {class: "row-main"},
          h("div", {class: "row-title"},
            h("strong", {}, Mock.section(m)),
            m.bridge ? h("span", {class: "tag"}, "CAN bridge") : null,
            h("span", {class: "note"}, m.board + " · " + m.chip + (m.role ? " · " + m.role : ""))),
          h("div", {class: "row-facts"},
            h("span", {class: m.behind ? "warn-text" : "ok-text"},
              Mock.short(m.version) + ", " + Mock.behindText(m)),
            h("span", {class: m.present ? "dot ok" : "dot err"},
              m.present ? "connected" : "not found: is it switched on?"),
            h("span", {}, Mock.METHODS[m.method].label)),
          h("div", {class: "row-dev mono"}, m.uuid ? "canbus_uuid " + m.uuid : m.device)),
        h("div", {class: "row-side"},
          n >= 0 ? h("span", {class: "order", title: Mock.reason(m)}, String(n + 1)) : null,
          side));

    return h("li", {class: "node"}, row,
        m.bridge ? h("ul", {}, busItem(m.bridge, "CAN bus through " + m.name + "'s bridge",
                                       Mock.children(m.name), order)) : null);
}

function renderStatus() {
    const order = Mock.plan().map(m => m.name);
    const kl = Mock.klipper();
    const blocking = kl.blocking.length;
    $("summary").className = "summary " + (blocking ? "warn" : "ok");
    const total = M.sc.mcus.length;
    $("summary").textContent = !blocking ? "Every board runs the host's Klipper commit."
        : total === 1 ? "The board blocks Klipper."
        : blocking === total ? "All " + total + " boards block Klipper."
        : blocking + " of " + total + " boards " + (blocking === 1 ? "blocks" : "block") + " Klipper.";
    $("host").textContent = Mock.HOST_VERSION + " on " + M.sc.host;
    $("klipper").textContent = M.run ? M.run.klipper : kl.text;

    $("tree").replaceChildren(h("li", {class: "host"},
        h("div", {class: "row host-row"}, h("strong", {}, M.sc.host),
          h("span", {class: "note"}, "Klipper host")),
        h("ul", {}, busItem("USB", null, Mock.roots(), order))));

    const plan = Mock.plan();
    $("order").replaceChildren(...(plan.length ? [
        h("h3", {}, "Flash order"),
        h("ol", {class: "order-list"}, plan.map(m =>
            h("li", {}, h("strong", {}, m.name), " — ", Mock.reason(m)))),
    ] : [h("p", {class: "note"}, "No board selected.")]));
}

function renderActions() {
    const blocker = Mock.flashBlocker();
    const n = Mock.plan().length;
    $("flash").disabled = blocker !== null;
    $("flash").textContent = n ? "Build and flash " + Mock.plural(n, "board") : "Build and flash";
    $("build-only").disabled = blocker !== null;
    $("action-note").textContent = blocker || "";
    $("running").hidden = !(M.run && !M.run.done && !M.run.buildOnly);
    const confirming = M.confirming && blocker === null;
    $("confirm").hidden = !confirming;
    if (confirming)
        $("confirm").replaceChildren(...Mock.confirmBox());
}

function renderOutput() {
    const r = M.run;
    const state = $("output-state");
    $("steps").hidden = $("log").hidden = !r;
    $("report").hidden = !(r && r.done);
    $("output-summary").hidden = !!r;
    if (!r) {
        $("output-title").textContent = "Output";
        state.hidden = true;
        return;
    }
    $("output-title").textContent = r.buildOnly ? "Build only" : "Flash run";
    state.hidden = false;
    state.className = "badge " + (!r.done ? "running" : r.failed ? "failed" : "ok");
    state.textContent = !r.done ? "Running" : r.failed ? "Failed" : "Finished";

    $("steps").replaceChildren(...r.steps.map((step, i) =>
        h("li", {class: "step " + r.stepStates[i]},
          h("span", {}, Mock.stepLabel(step)), Mock.badge(r.stepStates[i]))));
    $("report").replaceChildren(...(r.done ? Mock.reportBox() : []));
    $("log").replaceChildren(...Mock.logLines());
    $("log").scrollTop = $("log").scrollHeight;
}

$("flash").addEventListener("click", () => Mock.openConfirm());
$("build-only").addEventListener("click", () => Mock.startRun(true));

Mock.init(() => {
    renderStatus();
    renderActions();
    renderOutput();
});

})();
