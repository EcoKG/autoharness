/**
 * 단일 페이지 UI — 데몬이 정적 자원으로 서빙한다.
 *
 * **외부 CDN 을 쓰지 않는다.** 이 화면은 자율 주행이 멈췄는지 보러 여는 것이므로, 네트워크가
 * 죽은 상황에서도 떠야 한다. 폰트·스크립트·스타일 전부 이 파일 안에 있고, 그래서 단일 EXE
 * 에 그대로 담긴다.
 *
 * **DOM 은 문자열 조립이 아니라 createElement 로 만든다.** 화면에 찍히는 값(프로젝트 이름·
 * 작업 제목·로그 줄)은 전부 장부와 로그에서 오고, 그 안에는 무엇이든 들어갈 수 있다.
 * innerHTML 로 붙이면 로그 한 줄이 스크립트가 된다.
 *
 * 토큰은 sessionStorage 에만 둔다 — 탭을 닫으면 사라지고, localStorage 와 달리 다른 탭과
 * 공유되지 않는다.
 */

/**
 * **`String.raw` 를 쓰지 않는다.** 트랜스파일러가 생성 코드에서 비ASCII 문자를 `\uXXXX` 로
 * 이스케이프하는데, `String.raw` 는 그 이스케이프를 해석하지 않고 문자 그대로 남긴다 —
 * 그러면 화면에 한글 대신 `연` 이 찍힌다(실측으로 확인). 평범한 템플릿 리터럴은
 * 그 이스케이프를 원래 문자로 되돌린다. 이 문자열에는 백슬래시가 없으므로 안전하다.
 */
export const UI_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AutoHarness</title>
<style>
  :root {
    --bg: #0f1115; --panel: #171a21; --line: #262b35; --text: #e6e8ec;
    --dim: #9aa3b2; --accent: #6ea8fe; --ok: #4ade80; --warn: #fbbf24; --err: #f87171;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f6f7f9; --panel:#fff; --line:#e2e5ea; --text:#14171c; --dim:#5b6472; --accent:#1a56db; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { display:flex; gap:12px; align-items:center; padding:12px 16px; border-bottom:1px solid var(--line); flex-wrap:wrap; }
  h1 { font-size:15px; margin:0; font-weight:650; letter-spacing:.2px; }
  .sp { flex:1 }
  .muted { color:var(--dim); font-size:12px; }
  main { display:grid; grid-template-columns: 320px 1fr; gap:12px; padding:12px; align-items:start; }
  @media (max-width: 860px) { main { grid-template-columns: 1fr; } }
  section { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:12px; }
  section h2 { font-size:12px; text-transform:uppercase; letter-spacing:.6px; color:var(--dim); margin:0 0 8px; }
  button { font:inherit; background:var(--panel); color:var(--text); border:1px solid var(--line);
           border-radius:6px; padding:5px 10px; cursor:pointer; }
  button:hover:not(:disabled) { border-color:var(--accent); }
  button:disabled { opacity:.45; cursor:not-allowed; }
  input { font:inherit; background:var(--bg); color:var(--text); border:1px solid var(--line);
          border-radius:6px; padding:5px 8px; min-width:240px; }
  ul { list-style:none; margin:0; padding:0; }
  .proj { display:flex; flex-direction:column; gap:2px; padding:8px; border-radius:6px; cursor:pointer;
          border:1px solid transparent; }
  .proj:hover { border-color:var(--line); }
  .proj[aria-selected="true"] { border-color:var(--accent); background:rgba(110,168,254,.08); }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .badge { font-size:11px; padding:1px 7px; border-radius:999px; border:1px solid var(--line); color:var(--dim); }
  .badge.active { color:var(--ok); border-color:var(--ok); }
  .badge.paused, .badge.needs_human { color:var(--warn); border-color:var(--warn); }
  .badge.error { color:var(--err); border-color:var(--err); }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:5px 6px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--dim); font-weight:600; font-size:11px; text-transform:uppercase; }
  td.title { max-width:520px; }
  code, .mono { font-family:var(--mono); font-size:12px; }
  #console { background:#0b0d11; color:#d7dbe2; border-radius:6px; padding:8px; height:320px;
             overflow:auto; font-family:var(--mono); font-size:12px; white-space:pre-wrap; }
  @media (prefers-color-scheme: light) { #console { background:#11141a; color:#dfe3ea; } }
  .line { display:block; }
  .lvl-warn { color:var(--warn); } .lvl-error { color:var(--err); } .lvl-debug { color:var(--dim); }
  .line.session { color:#a5d6ff; }
  .line[hidden] { display:none; }
  .err { color:var(--err); }
  .ok { color:var(--ok); }
</style>
</head>
<body>
<header>
  <h1>AutoHarness</h1>
  <span id="conn" class="badge">연결 안 됨</span>
  <span id="tick" class="muted"></span>
  <span class="sp"></span>
  <input id="token" type="password" placeholder="web-token 붙여넣기" autocomplete="off">
  <button id="connect">연결</button>
  <button id="forget" title="이 탭에서 토큰을 지웁니다">토큰 지우기</button>
</header>

<p id="hint" class="muted" style="padding:0 16px">
  토큰은 <code>~/.claude/autoharness/web-token</code>
  — Windows 는 <code>%USERPROFILE%\\.claude\\autoharness\\web-token</code> — 파일에 있습니다.
  데몬이 뜰 때 정확한 경로를 로그에 남깁니다.
  입력한 토큰은 이 탭의 sessionStorage 에만 저장됩니다.
</p>

<main>
  <section>
    <h2>프로젝트</h2>
    <ul id="projects"></ul>
    <p id="noproj" class="muted">등록된 프로젝트가 없습니다.</p>
  </section>

  <div style="display:grid; gap:12px">
    <section>
      <h2>선택한 프로젝트</h2>
      <div id="detail" class="muted">왼쪽에서 프로젝트를 고르십시오.</div>
      <div class="row" style="margin-top:10px">
        <button data-act="pause" disabled>일시정지</button>
        <button data-act="resume" disabled>재개</button>
        <button data-act="tick" disabled>즉시 tick</button>
        <button data-act="launch" disabled>세션 기동</button>
      </div>
      <p id="actionMsg" class="muted"></p>
    </section>

    <section>
      <h2>설정</h2>
      <div class="row" style="gap:6px; flex-wrap:wrap">
        <label class="muted">검증 <input id="cfgTest" style="min-width:280px"></label>
        <label class="muted">시도 한도 <input id="cfgAttempts" type="number" min="1" style="min-width:70px"></label>
        <label class="muted">타임아웃(초) <input id="cfgTimeout" type="number" min="1" style="min-width:90px"></label>
        <button id="cfgSave">저장</button>
      </div>
      <p id="cfgMsg" class="muted">검증 명령은 이 저장소의 통과 기준입니다 — 바꾸면 다음 주행부터 적용됩니다.</p>
    </section>

    <section id="blockedBox" hidden>
      <h2>막힌 곳</h2>
      <div id="blocked"></div>
    </section>

    <section id="approvalBox" hidden>
      <h2>승인 대기</h2>
      <p class="muted" style="margin:0 0 8px">
        사람 판단이 필요해 봉인된 작업입니다. 되돌리면 다음 주행에서 다시 시도합니다.
      </p>
      <div id="approvals"></div>
    </section>

    <section>
      <h2>훅 배선</h2>
      <div id="wiring" class="muted">프로젝트를 고르면 확인합니다.</div>
    </section>

    <section>
      <h2>장부</h2>
      <table>
        <thead><tr><th>작업</th><th>상태</th><th>시도</th><th>커밋</th><th></th></tr></thead>
        <tbody id="tasks"></tbody>
      </table>
      <p id="notasks" class="muted">작업이 없습니다.</p>
    </section>

    <section>
      <h2>지난 세션 로그</h2>
      <div class="row" style="margin-bottom:6px">
        <select id="sessionPick" style="min-width:280px"></select>
        <button id="sessionOpen">열기</button>
        <span id="sessionMeta" class="muted"></span>
      </div>
      <div id="sessionBody" class="mono" style="white-space:pre-wrap; max-height:280px; overflow:auto"></div>
    </section>

    <section>
      <h2>콘솔</h2>
      <div class="row" style="margin-bottom:8px">
        <label class="muted"><input type="radio" name="mode" value="all" checked> 전체</label>
        <label class="muted"><input type="radio" name="mode" value="session"> 세션 출력만</label>
        <label class="muted"><input type="radio" name="mode" value="daemon"> 데몬 판단만</label>
        <input id="search" type="search" placeholder="줄 검색" style="min-width:160px">
        <button id="pin" title="자동 스크롤을 멈춥니다">고정</button>
        <span class="sp"></span>
        <span id="hidden" class="muted"></span>
      </div>
      <div id="chips" class="row" style="margin-bottom:8px"></div>
      <p id="consoleHint" class="muted" style="margin:0 0 6px">주행 중인 Claude Code 세션의 출력이 여기에 흐릅니다.</p>
      <div id="console" aria-live="polite"></div>
    </section>
  </div>
</main>

<script>
"use strict";
(function () {
  var KEY = "autoharness.token";
  var token = sessionStorage.getItem(KEY) || "";
  var selected = null;
  var socket = null;
  var state = { projects: [] };
  var maxAttempts = 0;
  var lastTasks = [];

  var $ = function (id) { return document.getElementById(id); };
  function setText(el, text) { el.textContent = text == null ? "" : String(text); }

  function api(path, options) {
    options = options || {};
    var headers = { authorization: "Bearer " + token };
    if (options.body) headers["content-type"] = "application/json";
    return fetch(path, { method: options.method || "GET", headers: headers, body: options.body })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (body) {
          if (!r.ok) throw new Error((body && body.error) || ("HTTP " + r.status));
          return body;
        });
      });
  }

  function badge(text, cls) {
    var el = document.createElement("span");
    el.className = "badge " + (cls || "");
    setText(el, text);
    return el;
  }

  function renderProjects() {
    var list = $("projects");
    list.replaceChildren();
    $("noproj").hidden = state.projects.length > 0;
    state.projects.forEach(function (p) {
      var li = document.createElement("li");
      li.className = "proj";
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(p.id === selected));

      var top = document.createElement("div");
      top.className = "row";
      var name = document.createElement("strong");
      setText(name, p.id);
      top.append(name, badge(p.status, p.status));
      if (p.needs_attention) top.append(badge("확인 필요", "warn"));

      var sub = document.createElement("div");
      sub.className = "muted mono";
      var bits = [];
      if (p.counts) bits.push("done " + p.counts.done + "/" + (p.counts.done + p.counts.pending +
        p.counts.in_progress + p.counts.failed + p.counts.blocked));
      if (p.next_task) bits.push("다음 " + p.next_task);
      if (p.next_retry_at) bits.push("백오프 " + p.next_retry_at.slice(0, 19).replace("T", " "));
      if (p.deadlocked && p.deadlocked.length) bits.push("교착 " + p.deadlocked.length);
      setText(sub, bits.join(" · "));

      li.append(top, sub);
      li.addEventListener("click", function () { select(p.id); });
      list.append(li);
    });
  }

  function renderDetail() {
    var p = state.projects.find(function (x) { return x.id === selected; });
    var box = $("detail");
    box.replaceChildren();
    document.querySelectorAll("[data-act]").forEach(function (b) { b.disabled = !p; });
    if (!p) { setText(box, "왼쪽에서 프로젝트를 고르십시오."); return; }

    var rows = [
      ["저장소", p.repo], ["상태", p.status], ["모델", p.model],
      ["연속 오류", String(p.consecutive_errors)], ["사용량 초과", String(p.limit_hits)],
      ["다음 재시도", p.next_retry_at || "-"],
      ["마지막 기동", p.last_launch && p.last_launch.ts ? p.last_launch.ts + " (" + p.last_launch.result + ")" : "없음"],
      ["장부", p.ledger_state],
    ];
    var dl = document.createElement("div");
    dl.className = "mono";
    rows.forEach(function (r) {
      var line = document.createElement("div");
      var k = document.createElement("span");
      k.className = "muted";
      setText(k, r[0] + ": ");
      var v = document.createElement("span");
      setText(v, r[1]);
      line.append(k, v);
      dl.append(line);
    });
    box.append(dl);
    if (p.needs_attention) {
      var warn = document.createElement("p");
      warn.className = "err";
      setText(warn, p.needs_attention);
      box.append(warn);
    }
  }

  /**
   * 작업 상세 — **원인까지 클릭 한 번.**
   *
   * last_error·last_log_file·deps·test_cmd 는 이미 /api/projects/:id/tasks 응답에 실려
   * 브라우저까지 와 있었는데 표가 id·상태·시도·커밋만 그리고 나머지를 버렸다. 그래서
   * "왜 실패했나" 를 보려면 화면을 떠나 로그 파일을 직접 열어야 했다.
   */
  function toggleDetail(task, row) {
    var next = row.nextSibling;
    if (next && next.getAttribute && next.getAttribute("data-detail") === task.id) {
      next.remove();
      return;
    }
    var tr = document.createElement("tr");
    tr.setAttribute("data-detail", task.id);
    var td = document.createElement("td");
    td.colSpan = 5;

    function part(label, value, mono) {
      if (!value) return;
      var p = document.createElement("p");
      p.className = "muted";
      p.style.margin = "4px 0";
      var b = document.createElement("strong");
      setText(b, label + ": ");
      var v = document.createElement("span");
      if (mono) v.className = "mono";
      v.style.whiteSpace = "pre-wrap";
      setText(v, value);
      p.append(b, v);
      td.append(p);
    }

    if (task.deps && task.deps.length) {
      // 의존은 이름만으로는 쓸모가 적다 — 그 작업이 지금 어떤 상태인지가 알고 싶은 것이다
      part("의존", task.deps.map(function (d) {
        var dep = lastTasks.filter(function (x) { return x.id === d; })[0];
        return d + "(" + (dep ? dep.status : "장부에 없음") + ")";
      }).join(", "));
    }
    part("전용 검증", task.test_cmd, true);
    part("로그", task.last_log_file, true);
    part("마지막 오류", task.last_error, true);
    tr.append(td);
    row.parentNode.insertBefore(tr, row.nextSibling);
  }

  /**
   * 막힌 곳 요약.
   *
   * **판정은 서버가 한다.** 화면이 eligibleNext·deadlockedPending 을 다시 계산하면 두 곳이
   * 갈라지고, 갈라진 화면이 "정상" 이라 말하는 순간이 v1 이 죽은 방식이다. 여기서는
   * 서버가 만든 사유를 그리기만 한다. 막힌 것이 없으면 절 자체가 사라진다.
   */
  function renderBlockers(list) {
    var box = $("blocked");
    box.replaceChildren();
    $("blockedBox").hidden = !list || !list.length;
    if (!list || !list.length) return;
    list.forEach(function (b) {
      var p = document.createElement("p");
      p.style.margin = "4px 0";
      var cls = b.kind === "blocked" ? "error" : b.kind === "attempts" ? "paused" : "";
      p.append(badge(b.kind === "blocked" ? "봉인" : b.kind === "attempts" ? "한도 임박" : "대기", cls));
      var t = document.createElement("span");
      t.className = "mono";
      setText(t, " " + b.id + " ");
      var r = document.createElement("span");
      r.className = "muted";
      setText(r, b.reason);
      p.append(t, r);
      box.append(p);
    });
  }

  /**
   * 승인 대기 큐.
   *
   * 사람 경계에 걸린 작업은 blocked 로 봉인되고 사유가 last_error 에 남는다. 그런데 그것을
   * **다시 살릴 흐름이 없었다** — 봉인된 채 쌓이기만 했고, 되살리려면 CLI 로 id 를 정확히
   * 쳐야 했다. 자율 주행 도구에서 "사람이 판단해 다시 넣는" 자리는 제어판의 핵심이다.
   *
   * 되돌리기가 시도 횟수를 지운다는 사실을 버튼에 미리 적는다 — 눌러 놓고 나중에 아는
   * 것과는 다르다.
   */
  function renderApprovals(tasks) {
    var box = $("approvals");
    box.replaceChildren();
    var waiting = (tasks || []).filter(function (t) { return t.status === "blocked"; });
    $("approvalBox").hidden = waiting.length === 0;
    if (!waiting.length) return;

    waiting.forEach(function (t) {
      var row = document.createElement("div");
      row.style.borderTop = "1px solid var(--line)";
      row.style.padding = "8px 0";

      var head = document.createElement("div");
      head.className = "row";
      var id = document.createElement("strong");
      id.className = "mono";
      setText(id, t.id);
      var title = document.createElement("span");
      title.className = "muted";
      setText(title, t.title);
      head.append(id, title);

      var why = document.createElement("p");
      why.className = "muted";
      why.style.cssText = "margin:4px 0; white-space:pre-wrap";
      setText(why, t.last_error || "사유 기록 없음");

      var actions = document.createElement("div");
      actions.className = "row";
      var again = document.createElement("button");
      setText(again, "승인하고 다시 넣기");
      again.title = t.attempts > 0
        ? "시도 횟수 " + t.attempts + " 이 0 으로 초기화됩니다"
        : "다음 주행에서 다시 시도합니다";
      again.addEventListener("click", function () { setTaskState(t.id, "pending"); });
      actions.append(again);

      row.append(head, why, actions);
      box.append(row);
    });
  }

  function renderTasks(tasks) {
    lastTasks = tasks;
    var body = $("tasks");
    body.replaceChildren();
    $("notasks").hidden = tasks.length > 0;
    tasks.forEach(function (t) {
      var tr = document.createElement("tr");
      function cell(text, cls) {
        var td = document.createElement("td");
        if (cls) td.className = cls;
        setText(td, text);
        return td;
      }
      tr.append(cell(t.id, "mono"));
      var st = document.createElement("td");
      st.append(badge(t.status, t.status === "done" ? "active" : t.status));
      tr.append(st);
      // 한도가 코앞이면 그 사실이 보여야 한다 — "4" 와 "4/5" 는 다른 정보다
      var attemptsCell = cell(maxAttempts ? t.attempts + "/" + maxAttempts : String(t.attempts));
      // 한도에 가까우면 눈에 띄게만 한다. **판정 문구는 쓰지 않는다** — 언제 봉인되는지는
      // 서버가 정하고 "막힌 곳" 카드가 말한다. 여기서 같은 문장을 쓰면 규칙이 바뀔 때 갈라진다.
      if (maxAttempts && t.attempts >= maxAttempts - 1 && t.status !== "done") {
        attemptsCell.className = "err";
      }
      tr.append(attemptsCell);
      tr.append(cell(t.commit || "-", "mono"));

      var act = document.createElement("td");
      // done 은 여기서 만들 수 없다 — 서버가 거부한다(장부 규칙을 UI 가 우회하지 않는다)
      var target = t.status === "blocked" ? "pending" : "blocked";
      var btn = document.createElement("button");
      setText(btn, target === "pending" ? "다시 pending" : "blocked 로");
      if (target === "pending" && t.attempts > 0) {
        btn.title = "시도 횟수 " + t.attempts + " 이 0 으로 초기화됩니다";
      }
      btn.addEventListener("click", function () { setTaskState(t.id, target); });
      act.append(btn);
      // 실패 원인은 이미 브라우저에 와 있다 — 펼쳐서 보여 준다
      if (t.last_error || (t.deps && t.deps.length) || t.last_log_file || t.test_cmd) {
        var more = document.createElement("button");
        setText(more, "자세히");
        more.addEventListener("click", function () { toggleDetail(t, tr); });
        act.append(more);
      }
      tr.append(act);

      var title = document.createElement("tr");
      var td = document.createElement("td");
      td.colSpan = 5;
      td.className = "muted title";
      setText(td, t.title);
      title.append(td);
      body.append(tr, title);
    });
  }

  function message(text, isError) {
    var el = $("actionMsg");
    el.className = isError ? "err" : "ok";
    setText(el, text);
  }

  /**
   * 훅 배선 카드 — v1 을 무너뜨린 실패 유형을 화면에서 잡는다.
   *
   * v1 은 워치독이 몇 주간 한 번도 돌지 않았는데 상태 조회가 계속 정상이라 보고했다.
   * 훅도 같은 성질이다 — 등록만 되고 발화하지 않아도 주행은 겉보기에 멀쩡하다.
   * harness_status 가 이미 배선 상태를 통째로 주므로 백엔드를 늘리지 않고 그것만 그린다.
   *
   * **미등록은 결함이 아니다.** 수동 운용도 정상 사용이라 회색으로 둔다. 붉게 칠하는 것은
   * "등록됐는데 발화하지 않는" 상태뿐이다 — 그때가 조용히 무너지는 순간이다.
   */
  function renderWiring(h) {
    var box = $("wiring");
    box.replaceChildren();
    if (!h) { box.className = "muted"; setText(box, "확인할 수 없습니다."); return; }

    var head = document.createElement("p");
    head.style.margin = "0 0 6px";
    var stateCls = h.state === "active" ? "active" : h.state === "inactive" ? "error" : "";
    head.append(badge(h.state, stateCls));
    box.append(head);

    var names = ["hook-prebash", "hook-postbash", "hook-stop", "hook-sessionstart"];
    var table = document.createElement("table");
    var tb = document.createElement("tbody");
    names.forEach(function (n) {
      var reg = (h.registered || []).indexOf(n) >= 0;
      var fired = (h.fired || []).indexOf(n) >= 0;
      var tr = document.createElement("tr");
      var c1 = document.createElement("td");
      c1.className = "mono";
      setText(c1, n);
      var c2 = document.createElement("td");
      c2.append(badge(reg ? "등록" : "미등록", reg ? "active" : ""));
      var c3 = document.createElement("td");
      // 등록됐는데 발화 기록이 없다 — 이것이 조용한 실패다
      c3.append(badge(fired ? "발화" : reg ? "발화 없음" : "-", fired ? "active" : reg ? "error" : ""));
      tr.append(c1, c2, c3);
      tb.append(tr);
    });
    table.append(tb);
    box.append(table);

    (h.repo_unpinned_hooks || []).length && warn(box,
      "저장소가 고정되지 않은 훅: " + h.repo_unpinned_hooks.join(", ") +
      " — 하위 디렉토리에서 게이트가 풀립니다.");
    (h.cwd_dependent_hooks || []).length && warn(box,
      "작업 디렉토리에 의존하는 훅: " + h.cwd_dependent_hooks.join(", "));
    (h.uncovered_tools || []).length && warn(box,
      "matcher 가 덮지 못하는 도구: " + h.uncovered_tools.join(", "));
    if (h.state === "inactive") {
      warn(box, "등록은 됐지만 발화 기록이 없습니다 — 저장소 루트에서 claude 를 실행하십시오.");
    }
    if (h.warning) warn(box, h.warning);
  }

  function warn(box, text) {
    var p = document.createElement("p");
    p.className = "err";
    p.style.margin = "6px 0 0";
    setText(p, text);
    box.append(p);
  }

  function loadWiring() {
    if (!selected) { renderWiring(null); return Promise.resolve(); }
    var proj = state.projects.filter(function (p) { return p.id === selected; })[0];
    if (!proj) { renderWiring(null); return Promise.resolve(); }
    return api("/api/mcp/call", {
      method: "POST",
      body: JSON.stringify({ name: "harness_status", arguments: { repo_path: proj.repo } })
    }).then(function (r) {
      var d = r && r.result;
      renderWiring(d && d.hooks);
    }).catch(function () { renderWiring(null); });
  }

  /**
   * 지난 세션 로그.
   *
   * 서버에는 목록·본문 API 가 **이미 있었는데 화면이 한 번도 부르지 않았다.** 그래서 지금
   * 흐르는 줄은 볼 수 있어도 "어젯밤 그 세션이 무엇을 했는지" 는 화면에서 볼 수 없었다.
   * 새 엔드포인트를 만들지 않고 있는 것을 쓴다.
   */
  function loadSessions() {
    var pick = $("sessionPick");
    pick.replaceChildren();
    if (!selected) return Promise.resolve();
    return api("/api/projects/" + encodeURIComponent(selected) + "/sessions")
      .then(function (r) {
        var list = (r && r.sessions) || [];
        if (!list.length) {
          var none = document.createElement("option");
          setText(none, "기록 없음");
          none.disabled = true;
          pick.append(none);
          return;
        }
        list.forEach(function (sfile) {
          var o = document.createElement("option");
          o.value = sfile.name;
          var when = sfile.mtime ? sfile.mtime.slice(0, 19).replace("T", " ") : sfile.name;
          setText(o, when + "  (" + Math.round(sfile.size / 1024) + "KB)");
          pick.append(o);
        });
      })
      .catch(function () { /* 로그가 없어도 화면은 살아 있어야 한다 */ });
  }

  function openSession() {
    var name = $("sessionPick").value;
    if (!selected || !name) return;
    setText($("sessionBody"), "불러오는 중…");
    api("/api/projects/" + encodeURIComponent(selected) + "/sessions/" + encodeURIComponent(name))
      .then(function (r) {
        setText($("sessionBody"), r.body || "(비어 있음)");
        // 잘렸으면 반드시 말한다 — 앞부분이 없는 줄 모르고 읽으면 엉뚱한 결론을 낸다
        setText($("sessionMeta"), r.truncated ? "뒷부분만 표시 중(파일이 큽니다)" : "");
        var box = $("sessionBody");
        box.scrollTop = box.scrollHeight;
      })
      .catch(function (e) { setText($("sessionBody"), e.message); });
  }

  /**
   * 설정 편집.
   *
   * 데몬 주기·백오프는 여기 없다 — 기동 의미론에 속해 사람 판단 경계다. 화면에 두면
   * 무심코 바뀐다.
   */
  function fillConfig(commands, maxAtt) {
    $("cfgTest").value = (commands && commands.test) || "";
    $("cfgTimeout").value = (commands && commands.timeout_sec) || "";
    $("cfgAttempts").value = maxAtt || "";
  }

  function saveConfig() {
    if (!selected) return;
    var body = {
      test: $("cfgTest").value,
      max_attempts: Number($("cfgAttempts").value),
      timeout_sec: Number($("cfgTimeout").value)
    };
    setText($("cfgMsg"), "저장 중…");
    api("/api/projects/" + encodeURIComponent(selected) + "/config", {
      method: "POST",
      body: JSON.stringify(body)
    }).then(function (r) {
      $("cfgMsg").className = "ok";
      setText($("cfgMsg"), "바뀐 항목: " + (r.changed || []).join(", "));
      return loadTasks();
    }).catch(function (e) {
      $("cfgMsg").className = "err";
      setText($("cfgMsg"), e.message);
    });
  }

  function refresh() {
    return api("/api/status").then(function (s) {
      state = s;
      setText($("tick"), s.last_tick ? "마지막 tick " + s.last_tick.slice(0, 19).replace("T", " ") : "tick 기록 없음");
      if (selected && !s.projects.some(function (p) { return p.id === selected; })) selected = null;
      if (!selected && s.projects.length) selected = s.projects[0].id;
      renderProjects();
      renderDetail();
      if (!selected) { renderTasks([]); return renderWiring(null); }
      return loadTasks().then(loadWiring).then(loadSessions);
    });
  }

  function loadTasks() {
    return api("/api/projects/" + encodeURIComponent(selected) + "/tasks")
      .then(function (r) {
        maxAttempts = r.max_attempts || 0;
        renderTasks(r.tasks || []);
        renderBlockers(r.blockers || []);
        renderApprovals(r.tasks || []);
        fillConfig(r.commands, r.max_attempts);
      })
      .catch(function (e) {
        renderTasks([]);
        renderBlockers([]);
        renderApprovals([]);
        message(e.message, true);
      });
  }

  function select(id) {
    selected = id;
    renderProjects();
    renderDetail();
    loadTasks();
  }

  // 결과를 그대로 말한다 — "완료" 라고만 하면 건너뛴 것도 기동된 것처럼 읽힌다.
  // 데몬은 프로젝트별 판단(action·detail)을 돌려주므로 그것을 보여 준다.
  function outcomeText(action, result) {
    var list = result && result.outcomes;
    if (!list || !list.length) return action + " 요청됨";
    return list.map(function (o) {
      return o.action === "launch" || o.action === "ok"
        ? o.project + ": 기동 — " + o.detail
        : o.project + ": " + o.action + " — " + o.detail;
    }).join(" / ");
  }

  function act(action) {
    if (!selected) return;
    message("요청 중…", false);
    api("/api/projects/" + encodeURIComponent(selected) + "/" + action, { method: "POST" })
      .then(function (r) {
        var text = outcomeText(action, r && r.result);
        // 건너뛴 것은 성공으로 칠하지 않는다 — 색까지 같으면 문구를 안 읽는다
        var skipped = /: skip /.test(text);
        message(text, false);
        if (skipped) $("actionMsg").className = "muted";
        return refresh();
      })
      .catch(function (e) { message(e.message, true); });
  }

  function setTaskState(taskId, status) {
    api("/api/tasks/" + encodeURIComponent(taskId) + "/state", {
      method: "POST",
      body: JSON.stringify({ project: selected, status: status })
    }).then(function (r) {
      // 시도 횟수를 지웠으면 반드시 말한다 — 몇 번 실패했는지가 사라지기 때문이다
      var extra = r && r.attemptsCleared ? " (시도 " + r.attemptsCleared + " → 0 초기화)" : "";
      message(taskId + " → " + status + extra, false);
      return loadTasks();
    })
      .catch(function (e) { message(e.message, true); });
  }

  var consoleMode = "all";
  var consoleQuery = "";
  var consoleProject = "";
  var pinned = false;
  var projectCounts = {};

  /**
   * 콘솔 필터.
   *
   * **숨긴 줄 수는 항상 보여 준다.** 필터가 걸린 것을 잊으면 "아무 일도 안 일어난다" 고
   * 읽는다 — 이 화면에서 그것이 가장 비싼 오해다.
   *
   * 백프레셔 알림(stream)은 어떤 필터에서도 숨기지 않는다. 화면이 따라오지 못해 줄을
   * 놓쳤다는 사실은 필터와 무관하게 알아야 한다.
   */
  function lineVisible(record) {
    if (record.action === "stream") return true;
    var isSession = record.action === "session";
    if (consoleMode === "session" && !isSession) return false;
    if (consoleMode === "daemon" && isSession) return false;
    if (consoleProject && record.project !== consoleProject) return false;
    if (consoleQuery && (record.text || "").toLowerCase().indexOf(consoleQuery) < 0) return false;
    return true;
  }

  function applyFilter() {
    var box = $("console");
    var hidden = 0;
    for (var i = 0; i < box.children.length; i++) {
      var el = box.children[i];
      var visible = lineVisible({
        action: el.getAttribute("data-action"),
        project: el.getAttribute("data-project"),
        text: el.textContent
      });
      el.hidden = !visible;
      if (!visible) hidden += 1;
    }
    setText($("hidden"), hidden ? hidden + "줄 숨김" : "");
    if (!pinned) box.scrollTop = box.scrollHeight;
  }

  function renderChips() {
    var box = $("chips");
    box.replaceChildren();
    var ids = Object.keys(projectCounts);
    if (ids.length < 2) return; // 하나뿐이면 칩이 오히려 방해다
    ids.unshift("");
    ids.forEach(function (id) {
      var b = document.createElement("button");
      setText(b, id ? id + " (" + projectCounts[id] + ")" : "전체");
      if (consoleProject === id) b.style.borderColor = "var(--accent)";
      b.addEventListener("click", function () {
        consoleProject = id;
        renderChips();
        applyFilter();
      });
      box.append(b);
    });
  }

  function appendLine(record) {
    var box = $("console");
    var atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    var line = document.createElement("span");
    var isSession = record.action === "session";
    // 세션 출력은 데몬 판단과 눈으로 구분돼야 한다 — 섞이면 어느 쪽도 못 읽는다
    line.className = "line lvl-" + record.level + (isSession ? " session" : "");
    line.setAttribute("data-action", record.action);
    line.setAttribute("data-project", record.project);
    var text = isSession
      ? record.ts.slice(11, 19) + "  " + record.project + " │ " + record.detail
      : record.ts.slice(11, 19) + "  " + record.project + "  " + record.action + "  " + record.detail;
    setText(line, text);
    line.hidden = !lineVisible(record);
    box.append(line);
    $("consoleHint").hidden = true;
    while (box.childElementCount > 2000) box.removeChild(box.firstChild);
    projectCounts[record.project] = (projectCounts[record.project] || 0) + 1;
    renderChips();
    if (line.hidden) setText($("hidden"), ($("console").querySelectorAll("[hidden]").length) + "줄 숨김");
    // 고정 중에는 따라가지 않는다 — 읽고 있는 자리를 뺏지 않기 위해서다
    if (atBottom && !pinned) box.scrollTop = box.scrollHeight;
  }

  function connectSocket() {
    if (socket) { try { socket.close(); } catch (e) {} }
    var proto = location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(proto + "://" + location.host + "/ws/console",
                           "autoharness.bearer." + token);
    socket.addEventListener("open", function () { setStatus("연결됨", "active"); });
    socket.addEventListener("close", function () {
      setStatus("끊김 — 5초 후 재연결", "error");
      setTimeout(function () { if (token) connectSocket(); }, 5000);
    });
    socket.addEventListener("message", function (ev) {
      var msg = JSON.parse(ev.data);
      if (msg.type === "log") appendLine(msg.record);
      else if (msg.type === "dropped") appendLine({ ts: new Date().toISOString(), level: "warn",
        project: "-", action: "stream", detail: msg.count + "줄을 놓쳤습니다(화면이 따라오지 못함)" });
    });
  }

  function setStatus(text, cls) {
    var el = $("conn");
    el.className = "badge " + (cls || "");
    setText(el, text);
  }

  function start() {
    token = $("token").value.trim() || token;
    if (!token) { message("토큰을 입력하십시오.", true); return; }
    sessionStorage.setItem(KEY, token);
    refresh().then(function () {
      setStatus("연결됨", "active");
      connectSocket();
      if (window.__ahPoll) clearInterval(window.__ahPoll);
      window.__ahPoll = setInterval(function () { refresh().catch(function () {}); }, 10000);
    }).catch(function (e) {
      setStatus("인증 실패", "error");
      message(e.message, true);
    });
  }

  $("cfgSave").addEventListener("click", saveConfig);
  $("sessionOpen").addEventListener("click", openSession);
  $("connect").addEventListener("click", start);
  $("token").addEventListener("keydown", function (e) { if (e.key === "Enter") start(); });
  $("forget").addEventListener("click", function () {
    sessionStorage.removeItem(KEY);
    token = "";
    $("token").value = "";
    if (socket) { try { socket.close(); } catch (e) {} }
    if (window.__ahPoll) clearInterval(window.__ahPoll);
    setStatus("연결 안 됨", "");
  });
  document.querySelectorAll("[data-act]").forEach(function (b) {
    b.addEventListener("click", function () { act(b.getAttribute("data-act")); });
  });
  $("search").addEventListener("input", function () {
    consoleQuery = $("search").value.trim().toLowerCase();
    applyFilter();
  });
  $("pin").addEventListener("click", function () {
    pinned = !pinned;
    setText($("pin"), pinned ? "고정 해제" : "고정");
    if (!pinned) { var b = $("console"); b.scrollTop = b.scrollHeight; }
  });
  document.querySelectorAll('input[name="mode"]').forEach(function (r) {
    r.addEventListener("change", function () {
      if (r.checked) { consoleMode = r.value; applyFilter(); }
    });
  });

  if (token) { $("token").value = token; start(); }
})();
</script>
</body>
</html>`;

/** 데몬이 서빙할 정적 자원 표. 외부 요청이 전혀 없는 자족 페이지 한 장이다. */
export const STATIC_ASSETS: Record<string, { body: string; type: string }> = {
  "/index.html": { body: UI_HTML, type: "text/html; charset=utf-8" },
};
