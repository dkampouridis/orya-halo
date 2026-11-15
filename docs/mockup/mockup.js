/*
 * Mockup behaviour: just enough to move between the states the lead needs to see.
 *
 * States come from the URL hash: #default, #selected, #selected-full (phone sheet at its full
 * stop), #search, #scrubbed, #idle, #offline. Add ?shot to freeze the clock and the idle timer
 * for screenshots. Add ?debug to log sea-lane points that fall on land.
 */
(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const params = new URLSearchParams(location.search);
  const STILL = params.has("shot");
  const STATES = ["default", "selected", "selected-full", "search", "scrubbed", "offline"];

  // The mockup's "now": 14 November 2026, 19:42:07 UTC, advancing in real time unless frozen.
  const BASE = Date.UTC(2026, 10, 14, 19, 42, 7);
  const t0 = performance.now();
  const now = () => (STILL ? BASE : BASE + (performance.now() - t0));

  const TOTALS = { live: "34,574", scrubbed: "34,391", offline: "13,943" };
  const PX_PER_MIN = 10;
  const BUFFER_MIN = 60;

  let state = "default";
  let scrub = 0; // minutes behind live
  let anchors = null;
  let lastKey = "";

  document.querySelectorAll("[data-icon]").forEach((el) => {
    el.innerHTML = window.HaloIcons.inline(el.dataset.icon);
  });

  const globe = $("#globe");
  const body = document.body;
  const input = $("#q");
  const tape = $("#tape");

  /* ---------- camera ---------- */

  function viewFor() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const phone = w <= 720;
    const selected = state.startsWith("selected");
    if (phone) {
      if (selected) {
        const full = state === "selected-full";
        return { lon: -48, lat: 36, radius: w * 1.05, anchor: [w / 2, full ? h * 0.15 : h * 0.33] };
      }
      return { lon: -25, lat: 30, radius: w * 0.56, cx: w / 2, cy: h * 0.44 };
    }
    if (selected) {
      // Park the aircraft in the clear water between the dock and the panel.
      const clear = (224 + (w - 356)) / 2;
      return { lon: -46, lat: 27.5, radius: h * 0.69, anchor: [clear - 16, h * 0.45] };
    }
    return { lon: -25, lat: 30, radius: Math.min(h * 0.445, w * 0.32), cx: w / 2, cy: h * 0.52 };
  }

  function layers() {
    const out = {};
    document.querySelectorAll(".row[data-layer]").forEach((r) => {
      out[r.dataset.layer] = r.getAttribute("aria-pressed") === "true";
    });
    return out;
  }

  function paint(fade) {
    const v = viewFor();
    const opts = Object.assign({}, v, {
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: Math.min(window.devicePixelRatio || 1, 2),
      time: BASE,
      minutesAgo: scrub,
      offline: state === "offline",
      selected: state.startsWith("selected"),
      hover: window.innerWidth > 720 && !("idle" in body.dataset),
      layers: layers(),
    });
    const key = JSON.stringify(opts);
    if (key === lastKey) return;
    const moved = lastKey && JSON.stringify(v) !== lastViewKey;
    lastKey = key;
    lastViewKey = JSON.stringify(v);
    const draw = () => {
      anchors = window.HaloGlobe.render(globe, opts);
      globe.classList.remove("is-moving");
      placeMarks();
    };
    // The real camera flies; the mockup can only cut, so it cross-fades instead.
    if (fade && moved && !STILL) {
      globe.classList.add("is-moving");
      setTimeout(draw, 200);
    } else {
      draw();
    }
  }
  let lastViewKey = "";

  function placeMarks() {
    if (!anchors) return;
    const put = (el, a, rotate) => {
      if (!a) {
        el.style.display = "none";
        return;
      }
      el.style.display = "";
      if (el instanceof SVGElement) {
        el.setAttribute(
          "transform",
          `translate(${a.x.toFixed(1)} ${a.y.toFixed(1)})${rotate ? ` rotate(${a.heading.toFixed(1)})` : ""}`,
        );
      } else {
        el.style.left = `${a.x.toFixed(1)}px`;
        el.style.top = `${a.y.toFixed(1)}px`;
      }
    };
    put($("#reticle"), anchors.selected, true);
    put($("#pick"), anchors.selected, false);
    put($("#hover-ring"), anchors.hover, true);
    put($("#tag"), anchors.hover, false);
    put($("#ripple"), anchors.quake, false);
    if (anchors.quake) {
      document
        .querySelectorAll("#ripple circle")
        .forEach((c) => c.setAttribute("r", anchors.quake.r.toFixed(1)));
    }
  }

  /* ---------- clock and tape ---------- */

  const two = (n) => String(n).padStart(2, "0");
  function hms(ms) {
    const d = new Date(ms);
    return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
  }

  function drawTape() {
    const svg = $("#ticks");
    const w = svg.clientWidth;
    const h = svg.clientHeight;
    if (!w) return;
    const needleX = Math.round(
      w * (parseFloat(getComputedStyle(tape.parentElement).getPropertyValue("--needle")) / 100),
    );
    const t = now();
    const under = t - scrub * 60000; // the instant under the needle
    const x = (ms) => needleX + ((ms - under) / 60000) * PX_PER_MIN;
    const base = h - 8;
    let out = "";
    const first = Math.max(
      Math.ceil((t - BUFFER_MIN * 60000) / 60000),
      Math.floor((under - (needleX / PX_PER_MIN) * 60000) / 60000),
    );
    const last = Math.floor(t / 60000);
    const flagEnd = needleX + 64;
    for (let m = first; m <= last; m++) {
      const px = Math.round(x(m * 60000)) + 0.5;
      if (px < -4 || px > w + 4) continue;
      const minute = new Date(m * 60000).getUTCMinutes();
      const major = minute % 5 === 0;
      out += `<line class="${major ? "major" : ""}" x1="${px}" x2="${px}" y1="${base - (major ? 11 : 5)}" y2="${base}"/>`;
      // Labels step aside for the needle readout, and on phones for the button in the tape.
      const clear = px < needleX - 20 || px > flagEnd + 18;
      const underButton = scrub > 0 && window.innerWidth <= 720 && px > w - 64;
      if (major && clear && !underButton) {
        const d = new Date(m * 60000);
        out += `<text x="${px}" y="${base - 17}">${two(d.getUTCHours())}:${two(minute)}</text>`;
      }
    }
    if (scrub > 0.05) {
      // How far behind live the needle sits: a line along the base, ending at "now".
      const nowX = Math.round(x(t)) + 0.5;
      out += `<line class="behind" x1="${needleX}" x2="${nowX}" y1="${base + 0.5}" y2="${base + 0.5}"/>`;
      out += `<line class="now" x1="${nowX}" x2="${nowX}" y1="${base - 15}" y2="${base}"/>`;
    }
    svg.innerHTML = out;
  }

  function tick() {
    $("#clock").textContent = hms(now() - scrub * 60000);
    drawTape();
  }

  /* ---------- states ---------- */

  function setState(next, fromHash) {
    if (!STATES.includes(next)) next = "default";
    if (next !== "scrubbed") scrub = 0;
    else if (scrub === 0) scrub = 12;
    state = next;
    body.dataset.state = state;
    if (!fromHash && location.hash.slice(1) !== state) history.replaceState(null, "", `#${state}`);

    const live = scrub === 0;
    $("#flag").innerHTML = live ? "live" : `<span class="num">−${Math.round(scrub)}</span> min`;
    tape.setAttribute("aria-valuenow", String(-Math.round(scrub)));
    tape.setAttribute("aria-valuetext", live ? "Live" : `${Math.round(scrub)} minutes ago`);
    $("#total").textContent =
      state === "offline" ? TOTALS.offline : live ? TOTALS.live : TOTALS.scrubbed;
    $("#total-unit").textContent = live ? "live" : "in replay";

    const searching = state === "search";
    input.setAttribute("aria-expanded", String(searching));
    if (searching) {
      input.value = "atl";
      input.focus({ preventScroll: true });
      input.setSelectionRange(3, 3);
    } else {
      input.value = "";
      if (document.activeElement === input) input.blur();
    }
    $(".sheet-handle").setAttribute(
      "aria-label",
      state === "selected-full" ? "Collapse details" : "Expand details",
    );
    tick();
    paint(true);
  }

  function fromHash() {
    const h = location.hash.slice(1) || "default";
    if (h === "idle") {
      body.dataset.idle = "";
      setState("default", true);
      return;
    }
    delete body.dataset.idle;
    setState(h, true);
  }

  /* ---------- idle ---------- */

  let idleTimer = 0;
  function wake() {
    if (STILL) return;
    if (location.hash.slice(1) !== "idle" && "idle" in body.dataset) {
      delete body.dataset.idle;
      paint(false);
    }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (state === "default" || state.startsWith("selected")) {
        body.dataset.idle = "";
        paint(false);
      }
    }, 8000);
  }

  /* ---------- wiring ---------- */

  $("#pick").addEventListener("click", () => setState("selected"));
  $(".sheet-handle").addEventListener("click", () =>
    setState(state === "selected-full" ? "selected" : "selected-full"),
  );
  $(".search-field").addEventListener("click", () => {
    if (state !== "search") setState("search");
  });
  input.addEventListener("focus", () => {
    if (state !== "search" && !STILL) setState("search");
  });

  document.querySelectorAll(".row[data-layer]").forEach((row) => {
    row.addEventListener("click", () => {
      if (row.dataset.status === "needs-key") {
        const open = row.getAttribute("aria-expanded") !== "true";
        row.setAttribute("aria-expanded", String(open));
        row.parentElement.querySelector(".row-note").hidden = !open;
        return;
      }
      row.setAttribute("aria-pressed", String(row.getAttribute("aria-pressed") !== "true"));
      paint(false);
    });
  });

  function moveResult(step) {
    const all = Array.from(document.querySelectorAll(".result"));
    const i = all.findIndex((r) => r.getAttribute("aria-selected") === "true");
    all[i].setAttribute("aria-selected", "false");
    all[(i + step + all.length) % all.length].setAttribute("aria-selected", "true");
  }

  function setScrub(minutes) {
    scrub = Math.max(0, Math.min(BUFFER_MIN, minutes));
    setState(scrub > 0 ? "scrubbed" : "default");
  }

  document.addEventListener("keydown", (e) => {
    if (state === "search") {
      if (e.key === "Escape" || e.key === "Enter") setState("default");
      else if (e.key === "ArrowDown") moveResult(1);
      else if (e.key === "ArrowUp") moveResult(-1);
      else return;
      e.preventDefault();
      return;
    }
    if (e.key === "/") {
      e.preventDefault();
      setState("search");
    } else if (e.key === "Escape") {
      setState("default");
    } else if (document.activeElement === tape) {
      if (e.key === "ArrowLeft") setScrub(Math.round(scrub) + 1);
      else if (e.key === "ArrowRight") setScrub(Math.round(scrub) - 1);
      else if (e.key === "End") setScrub(0);
      else if (e.key === "Home") setScrub(BUFFER_MIN);
    }
  });

  // Dragging the tape moves through the buffered history.
  let drag = null;
  tape.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, scrub };
    tape.setPointerCapture(e.pointerId);
  });
  tape.addEventListener("pointermove", (e) => {
    if (!drag) return;
    scrub = Math.max(0, Math.min(BUFFER_MIN, drag.scrub + (e.clientX - drag.x) / PX_PER_MIN));
    const live = scrub === 0;
    $("#flag").innerHTML = live ? "live" : `<span class="num">−${Math.round(scrub)}</span> min`;
    tick();
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    setScrub(Math.round(scrub));
  };
  tape.addEventListener("pointerup", endDrag);
  tape.addEventListener("pointercancel", endDrag);

  window.addEventListener("hashchange", fromHash);
  ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"].forEach((type) =>
    window.addEventListener(type, wake, { passive: true }),
  );
  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      paint(false);
      drawTape();
    }, 120);
  });

  /* ---------- start ---------- */

  const fonts = document.fonts ? document.fonts.ready : Promise.resolve();
  Promise.all([window.HaloGlobe.loadWorld(), fonts]).then(([world]) => {
    if (!world)
      console.warn("Coastlines could not be loaded (offline?). The globe is drawn without land.");
    if (params.has("debug"))
      console.log("lanes on land:", JSON.stringify(window.HaloGlobe.auditLanes()));
    fromHash();
    wake();
    if (!STILL) setInterval(tick, 1000);
    document.documentElement.dataset.ready = "";
    window.__haloReady = true;
  });
})();
