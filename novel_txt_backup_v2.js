(() => {
  "use strict";

  const APP_ID = "novel-txt-backup-overlay";
  const POLL_MS = 350;
  const EPISODE_TIMEOUT_MS = 30000;
  const BETWEEN_EPISODES_MS = 700;

  if (!/^\/novel\/\d+\/?$/.test(location.pathname)) {
    alert("작품 목록 페이지에서 실행해 주세요.\n예: /novel/63209");
    return;
  }

  const old = document.getElementById(APP_ID);
  if (old) old.remove();

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function sanitizeFilename(value) {
    return String(value || "novel")
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
  }

  function parseEpisodePage(href) {
    try {
      const url = new URL(href, location.href);
      return Number(url.searchParams.get("epage") || "1") || 1;
    } catch (_) {
      return 1;
    }
  }

  function detectLastListPage(doc) {
    let max = 1;
    doc.querySelectorAll('nav.theme-episode-pager a[href*="epage="]').forEach((a) => {
      max = Math.max(max, parseEpisodePage(a.href));
    });
    return max;
  }

  function parseEpisodes(doc) {
    const out = [];
    doc.querySelectorAll('li.list-item[data-index]').forEach((li) => {
      const num = Number(li.getAttribute("data-index"));
      const a = li.querySelector('a.item-subject[href]');
      if (!Number.isFinite(num) || !a) return;

      out.push({
        number: num,
        title: (a.textContent || `${num}화`).trim().replace(/\s+/g, " "),
        url: new URL(a.getAttribute("href"), location.origin).href,
      });
    });
    return out;
  }

  function getWorkTitle() {
    const h2 = document.querySelector(".page-title h2 span");
    if (h2?.textContent?.trim()) return h2.textContent.trim();

    const og = document.querySelector('meta[property="og:title"]');
    if (og?.content) return og.content.replace(/\s*-\s*북토끼 소설\s*$/, "").trim();

    return document.title.replace(/\s*-\s*북토끼 소설\s*$/, "").trim() || "novel";
  }

  function createOverlay() {
    const root = document.createElement("div");
    root.id = APP_ID;
    root.innerHTML = `
      <div style="
        position:fixed;left:50%;bottom:18px;transform:translateX(-50%);
        z-index:2147483647;width:min(92vw,420px);
        background:#111827;color:#fff;border-radius:14px;
        box-shadow:0 8px 35px rgba(0,0,0,.38);
        padding:14px 15px;font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo',sans-serif;
        font-size:14px;line-height:1.45;
      ">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
          <strong>TXT 백업</strong>
          <button data-close style="
            border:0;background:transparent;color:#cbd5e1;font-size:20px;line-height:1;cursor:pointer
          ">×</button>
        </div>

        <div data-title style="margin-top:6px;color:#e5e7eb;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>

        <div style="height:8px;background:#374151;border-radius:999px;overflow:hidden;margin-top:10px">
          <div data-bar style="height:100%;width:0%;background:#f9fafb;transition:width .15s linear"></div>
        </div>

        <div data-status style="margin-top:8px;color:#d1d5db">준비 중...</div>

        <div data-actions style="display:none;gap:8px;margin-top:12px">
          <button data-save style="
            flex:1;border:0;border-radius:9px;padding:9px 10px;
            background:#fff;color:#111827;font-weight:700;cursor:pointer
          ">TXT 저장</button>
          <button data-dismiss style="
            border:1px solid #4b5563;border-radius:9px;padding:9px 12px;
            background:transparent;color:#fff;cursor:pointer
          ">닫기</button>
        </div>
      </div>
    `;
    document.documentElement.appendChild(root);

    const close = () => root.remove();
    root.querySelector("[data-close]").addEventListener("click", close);
    root.querySelector("[data-dismiss]").addEventListener("click", close);

    return {
      root,
      title: root.querySelector("[data-title]"),
      bar: root.querySelector("[data-bar]"),
      status: root.querySelector("[data-status]"),
      actions: root.querySelector("[data-actions]"),
      save: root.querySelector("[data-save]"),
    };
  }

  async function fetchDocument(url) {
    const res = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "text/html,application/xhtml+xml" },
    });

    if (!res.ok) {
      throw new Error(`목록 페이지 요청 실패: HTTP ${res.status}`);
    }

    const html = await res.text();
    return new DOMParser().parseFromString(html, "text/html");
  }

  async function collectAllEpisodes(ui) {
    const firstDoc = document;
    const lastPage = detectLastListPage(firstDoc);
    const map = new Map();

    for (const ep of parseEpisodes(firstDoc)) {
      map.set(ep.number, ep);
    }

    for (let page = 2; page <= lastPage; page++) {
      ui.status.textContent = `회차 목록 확인 중... ${page}/${lastPage}`;
      const doc = await fetchDocument(`${location.pathname}?epage=${page}`);
      for (const ep of parseEpisodes(doc)) {
        map.set(ep.number, ep);
      }
    }

    return [...map.values()].sort((a, b) => a.number - b.number);
  }

  function findBlockReason(win, doc) {
    let text = "";
    let title = "";
    let href = "";

    try {
      text = (doc?.body?.innerText || "").slice(0, 12000);
      title = doc?.title || "";
      href = win?.location?.href || "";
    } catch (_) {}

    const hay = `${title}\n${text}\n${href}`;

    if (/\b403\b|forbidden|access\s*denied/i.test(hay)) {
      return "403 / 접근 거부 화면이 감지됨";
    }

    if (/captcha|캡차|자동\s*입력\s*방지|로봇이\s*아닙니다|인증이\s*필요합니다/i.test(hay)) {
      return "CAPTCHA / 추가 인증 화면이 감지됨";
    }

    if (/본문\s*보안\s*검증에\s*실패|광고\s*검증\s*후\s*다시|일일\s*조회\s*인증이\s*필요/i.test(hay)) {
      return "본문 보안/조회 인증이 필요함";
    }

    if (/로그인이\s*필요합니다/i.test(hay)) {
      return "로그인이 필요함";
    }

    return "";
  }

  async function loadEpisodeText(episode, ui) {
    return new Promise((resolve, reject) => {
      const iframe = document.createElement("iframe");
      iframe.setAttribute("aria-hidden", "true");

      Object.assign(iframe.style, {
        position: "fixed",
        left: "-10000px",
        top: "0",
        width: "8px",
        height: "8px",
        opacity: "0.01",
        pointerEvents: "none",
        border: "0",
      });

      let finished = false;
      let pollTimer = null;
      let timeoutTimer = null;

      function cleanup() {
        if (pollTimer) clearInterval(pollTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        try { iframe.remove(); } catch (_) {}
      }

      function fail(message) {
        if (finished) return;
        finished = true;
        cleanup();
        reject(new Error(message));
      }

      function succeed(text) {
        if (finished) return;
        finished = true;
        cleanup();
        resolve(
          String(text || "")
            .replace(/\r\n?/g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim()
        );
      }

      iframe.addEventListener("load", () => {
        // 실제 본문은 load 이후 비동기로 생성되므로 여기서는 바로 읽지 않음.
      });

      document.body.appendChild(iframe);
      iframe.src = episode.url;

      pollTimer = setInterval(() => {
        try {
          const win = iframe.contentWindow;
          const doc = iframe.contentDocument;

          if (!win || !doc) return;

          const blocked = findBlockReason(win, doc);
          if (blocked) {
            fail(`${episode.number}화: ${blocked}`);
            return;
          }

          const text = win.__novelTTSText;
          if (typeof text === "string" && text.trim().length > 0) {
            succeed(text);
            return;
          }

          const contentHost = doc.querySelector("[data-theme-novel-content]");
          const visibleMessage = contentHost?.textContent?.trim() || "";

          if (
            visibleMessage &&
            !/본문\s*불러오는\s*중/i.test(visibleMessage) &&
            /실패|오류|인증|로그인|준비되지\s*않았습니다/i.test(visibleMessage)
          ) {
            fail(`${episode.number}화: ${visibleMessage}`);
          }
        } catch (err) {
          // 일시적인 로딩 중 접근 오류는 timeout까지 기다림.
        }
      }, POLL_MS);

      timeoutTimer = setTimeout(() => {
        fail(`${episode.number}화: ${Math.round(EPISODE_TIMEOUT_MS / 1000)}초 동안 본문을 불러오지 못함`);
      }, EPISODE_TIMEOUT_MS);
    });
  }

  function buildTxt(workTitle, chapters, actualStart, actualEnd) {
    const lines = [];

    // EPUB 변환기가 첫 줄에서 작품명/범위를 읽기 쉽게 고정 형식 사용
    lines.push(`${workTitle}_${actualStart}~${actualEnd}화`);
    lines.push("");
    lines.push("");

    // 각 회차는 반드시 "##숫자화" 한 줄로 시작
    // EPUB 변환기에서는 /^##(\\d+)화$/m 기준으로 분할하면 됨.
    for (const ch of chapters) {
      lines.push(`##${ch.number}화`);
      lines.push("");
      lines.push(ch.text);
      lines.push("");
      lines.push("");
    }

    return lines.join("\n");
  }

  function prepareTxtDownload(ui, filename, text) {
    const blob = new Blob(["\uFEFF", text], {
      type: "text/plain;charset=utf-8",
    });

    const objectUrl = URL.createObjectURL(blob);

    const save = () => {
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    };

    ui.actions.style.display = "flex";
    ui.save.onclick = save;

    // 데스크톱/일부 Safari에서는 자동 저장됨.
    // iOS가 비동기 다운로드를 막는 경우를 위해 TXT 저장 버튼도 유지함.
    try { save(); } catch (_) {}

    setTimeout(() => URL.revokeObjectURL(objectUrl), 10 * 60 * 1000);
  }

  async function main() {
    const ui = createOverlay();
    const workTitle = getWorkTitle();
    ui.title.textContent = workTitle;

    let allEpisodes;

    try {
      allEpisodes = await collectAllEpisodes(ui);
    } catch (err) {
      ui.status.textContent = err?.message || "회차 목록을 가져오지 못했습니다.";
      return;
    }

    if (!allEpisodes.length) {
      ui.status.textContent = "회차 목록을 찾지 못했습니다.";
      return;
    }

    const minEpisode = allEpisodes[0].number;
    const maxEpisode = allEpisodes[allEpisodes.length - 1].number;

    const startRaw = prompt(
      `몇 화부터 받을까요?\n가능 범위: ${minEpisode} ~ ${maxEpisode}`,
      String(minEpisode)
    );

    if (startRaw === null) {
      ui.root.remove();
      return;
    }

    const endRaw = prompt(
      `몇 화까지 받을까요?\n가능 범위: ${minEpisode} ~ ${maxEpisode}`,
      String(maxEpisode)
    );

    if (endRaw === null) {
      ui.root.remove();
      return;
    }

    let startEpisode = Number(String(startRaw).trim());
    let endEpisode = Number(String(endRaw).trim());

    if (!Number.isInteger(startEpisode) || !Number.isInteger(endEpisode)) {
      ui.status.textContent = "화수는 숫자로 입력해야 합니다.";
      return;
    }

    if (startEpisode > endEpisode) {
      [startEpisode, endEpisode] = [endEpisode, startEpisode];
    }

    startEpisode = Math.max(startEpisode, minEpisode);
    endEpisode = Math.min(endEpisode, maxEpisode);

    const targets = allEpisodes.filter(
      (ep) => ep.number >= startEpisode && ep.number <= endEpisode
    );

    if (!targets.length) {
      ui.status.textContent = "해당 범위에 회차가 없습니다.";
      return;
    }

    const chapters = [];
    let stopReason = "";

    for (let i = 0; i < targets.length; i++) {
      const ep = targets[i];
      const pct = Math.round((i / targets.length) * 100);

      ui.bar.style.width = `${pct}%`;
      ui.status.textContent =
        `${ep.number}화 받는 중... (${i + 1}/${targets.length})`;

      try {
        const text = await loadEpisodeText(ep, ui);

        if (!text) {
          throw new Error(`${ep.number}화: 본문이 비어 있음`);
        }

        chapters.push({
          number: ep.number,
          title: ep.title,
          text,
        });
      } catch (err) {
        stopReason = err?.message || `${ep.number}화에서 중단됨`;
        break;
      }

      await sleep(BETWEEN_EPISODES_MS);
    }

    ui.bar.style.width = "100%";

    if (!chapters.length) {
      ui.status.textContent = stopReason
        ? `중단됨: ${stopReason}\n저장할 본문이 없습니다.`
        : "저장할 본문이 없습니다.";
      return;
    }

    const actualStart = chapters[0].number;
    const actualEnd = chapters[chapters.length - 1].number;
    const partial = actualEnd < endEpisode;

    const txt = buildTxt(
      workTitle,
      chapters,
      actualStart,
      actualEnd
    );

    const filename = sanitizeFilename(
      `${workTitle}_${actualStart}~${actualEnd}화.txt`
    );

    if (partial) {
      ui.status.innerHTML =
        `<b>${actualStart}~${actualEnd}화까지 저장됨</b><br>` +
        `<span style="color:#fca5a5">${escapeHtml(stopReason)}</span><br>` +
        `중단 직전까지의 TXT를 준비했습니다.`;
    } else {
      ui.status.innerHTML =
        `<b>${actualStart}~${actualEnd}화 완료</b><br>` +
        `${chapters.length}개 회차를 TXT로 준비했습니다.`;
    }

    prepareTxtDownload(ui, filename, txt);
  }

  main().catch((err) => {
    console.error(err);
    alert(err?.message || String(err));
  });
})();
