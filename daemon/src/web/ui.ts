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
      <h2>장부</h2>
      <table>
        <thead><tr><th>작업</th><th>상태</th><th>시도</th><th>커밋</th><th></th></tr></thead>
        <tbody id="tasks"></tbody>
      </table>
      <p id="notasks" class="muted">작업이 없습니다.</p>
    </section>

    <section>
      <h2>콘솔</h2>
      <div class="row" style="margin-bottom:8px">
        <label class="muted"><input type="radio" name="mode" value="all" checked> 전체</label>
        <label class="muted"><input type="radio" name="mode" value="session"> 세션 출력만</label>
        <label class="muted"><input type="radio" name="mode" value="daemon"> 데몬 판단만</label>
        <span class="sp"></span>
        <span id="consoleHint" class="muted">주행 중인 Claude Code 세션의 출력이 여기에 흐릅니다.</span>
      </div>
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
      if (maxAttempts && t.attempts >= maxAttempts - 1 && t.status !== "done") {
        attemptsCell.className = "err";
        attemptsCell.title = "다음 실패에 봉인됩니다";
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

  function refresh() {
    return api("/api/status").then(function (s) {
      state = s;
      setText($("tick"), s.last_tick ? "마지막 tick " + s.last_tick.slice(0, 19).replace("T", " ") : "tick 기록 없음");
      if (selected && !s.projects.some(function (p) { return p.id === selected; })) selected = null;
      if (!selected && s.projects.length) selected = s.projects[0].id;
      renderProjects();
      renderDetail();
      return selected ? loadTasks() : renderTasks([]);
    });
  }

  function loadTasks() {
    return api("/api/projects/" + encodeURIComponent(selected) + "/tasks")
      .then(function (r) { maxAttempts = r.max_attempts || 0; renderTasks(r.tasks || []); })
      .catch(function (e) { renderTasks([]); message(e.message, true); });
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

  function lineVisible(record) {
    if (consoleMode === "all") return true;
    var isSession = record.action === "session";
    return consoleMode === "session" ? isSession : !isSession;
  }

  function applyFilter() {
    var box = $("console");
    for (var i = 0; i < box.children.length; i++) {
      var el = box.children[i];
      el.hidden = !lineVisible({ action: el.getAttribute("data-action") });
    }
    box.scrollTop = box.scrollHeight;
  }

  function appendLine(record) {
    var box = $("console");
    var atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    var line = document.createElement("span");
    var isSession = record.action === "session";
    // 세션 출력은 데몬 판단과 눈으로 구분돼야 한다 — 섞이면 어느 쪽도 못 읽는다
    line.className = "line lvl-" + record.level + (isSession ? " session" : "");
    line.setAttribute("data-action", record.action);
    var text = isSession
      ? record.ts.slice(11, 19) + "  " + record.project + " │ " + record.detail
      : record.ts.slice(11, 19) + "  " + record.project + "  " + record.action + "  " + record.detail;
    setText(line, text);
    line.hidden = !lineVisible(record);
    box.append(line);
    while (box.childElementCount > 2000) box.removeChild(box.firstChild);
    if (atBottom) box.scrollTop = box.scrollHeight;
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
