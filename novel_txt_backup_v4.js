(() => {
  "use strict";

  const APP_ID = "novel-txt-backup-overlay-v6-1";

  const POLL_MS = 400;
  const NORMAL_TIMEOUT_MS = 45000;
  const MANUAL_AUTH_TIMEOUT_MS = 10 * 60 * 1000;
  const BETWEEN_EPISODES_MS = 900;

  // 정상적으로 20개 회차를 수집할 때마다 수집창 교체
  const ROTATE_EVERY_EPISODES = 20;

  // 실수로 창을 닫거나 일반 로딩 실패가 났을 때
  // 같은 화를 새 창으로 다시 시도하는 횟수
  const MAX_RECOVERY_RETRIES = 2;

  const RESUME_KEY =
    `novelTxtBackupV61:${location.pathname}`;

  let collectorWin =
    window.__novelBackupWin || null;

  let stopRequested = false;

  /*
    자동 팝업이 막혀 버튼 클릭을 기다리는 동안에도
    '지금까지 저장하고 중단'을 누르면
    기다림을 즉시 끝내기 위한 목록
  */
  const stopWaiters = new Set();


  /*
    작품 목록에서만 실행
  */
  if (!/^\/novel\/\d+\/?$/.test(location.pathname)) {
    alert("작품 목록 페이지에서 실행해 주세요.");
    return;
  }


  const old =
    document.getElementById(APP_ID);

  if (old) {
    old.remove();
  }


  const sleep = (ms) =>
    new Promise(resolve =>
      setTimeout(resolve, ms)
    );


  function notifyStopWaiters() {
    for (const fn of stopWaiters) {
      try {
        fn();
      } catch (_) {}
    }

    stopWaiters.clear();
  }


  function createUserStoppedError() {
    return Object.assign(
      new Error("사용자가 수집을 중단했습니다."),
      {
        userStopped: true
      }
    );
  }


  function sanitizeFilename(value) {
    return String(value || "novel")
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 150);
  }


  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }


  function getWorkTitle() {
    const h2 =
      document.querySelector(
        ".page-title h2 span"
      );

    if (
      h2?.textContent?.trim()
    ) {
      return h2.textContent.trim();
    }


    const og =
      document.querySelector(
        'meta[property="og:title"]'
      );

    if (og?.content) {
      return og.content
        .replace(
          /\s*-\s*북토끼 소설\s*$/,
          ""
        )
        .trim();
    }


    return (
      document.title
        .replace(
          /\s*-\s*북토끼 소설\s*$/,
          ""
        )
        .trim() ||
      "novel"
    );
  }


  function parseEpisodePage(href) {
    try {
      const url =
        new URL(
          href,
          location.href
        );

      return (
        Number(
          url.searchParams.get("epage") ||
          "1"
        ) || 1
      );

    } catch (_) {
      return 1;
    }
  }


  function detectLastListPage(doc) {
    let max = 1;

    doc
      .querySelectorAll(
        'nav.theme-episode-pager a[href*="epage="]'
      )
      .forEach(a => {

        max = Math.max(
          max,
          parseEpisodePage(a.href)
        );

      });

    return max;
  }


  function parseEpisodes(doc) {
    const out = [];

    doc
      .querySelectorAll(
        'li.list-item[data-index]'
      )
      .forEach(li => {

        const num =
          Number(
            li.getAttribute(
              "data-index"
            )
          );

        const a =
          li.querySelector(
            'a.item-subject[href]'
          );

        if (
          !Number.isFinite(num) ||
          !a
        ) {
          return;
        }

        out.push({
          number: num,

          title:
            (
              a.textContent ||
              `${num}화`
            )
              .trim()
              .replace(/\s+/g, " "),

          url:
            new URL(
              a.getAttribute("href"),
              location.origin
            ).href
        });

      });

    return out;
  }


  /*
    진행창
  */
  function createOverlay() {
    const root =
      document.createElement("div");

    root.id = APP_ID;

    root.innerHTML = `
      <div
        style="
          position:fixed;
          left:50%;
          bottom:18px;
          transform:translateX(-50%);
          z-index:2147483647;

          width:min(92vw,460px);

          background:#111827;
          color:#fff;

          border-radius:14px;

          box-shadow:
            0 8px 35px
            rgba(0,0,0,.4);

          padding:14px 15px;

          font-family:
            -apple-system,
            BlinkMacSystemFont,
            'Apple SD Gothic Neo',
            sans-serif;

          font-size:14px;
          line-height:1.45;
        "
      >

        <div
          style="
            display:flex;
            align-items:center;
            justify-content:space-between;
          "
        >
          <strong>
            TXT 백업 v6.1
          </strong>

          <button
            data-close
            style="
              border:0;
              background:transparent;
              color:#cbd5e1;
              font-size:20px;
              cursor:pointer;
            "
          >
            ×
          </button>
        </div>


        <div
          data-title
          style="
            margin-top:6px;
            color:#e5e7eb;
            white-space:nowrap;
            overflow:hidden;
            text-overflow:ellipsis;
          "
        ></div>


        <div
          style="
            height:8px;
            background:#374151;
            border-radius:999px;
            overflow:hidden;
            margin-top:10px;
          "
        >
          <div
            data-bar
            style="
              height:100%;
              width:0%;
              background:#fff;
              transition:width .15s linear;
            "
          ></div>
        </div>


        <div
          data-status
          style="
            margin-top:8px;
            color:#d1d5db;
            white-space:pre-line;
          "
        >
          준비 중...
        </div>


        <div
          data-auth
          style="
            display:none;
            margin-top:10px;
            padding:10px 11px;
            border-radius:9px;
            background:#3b2f16;
            color:#fde68a;
            white-space:pre-line;
          "
        ></div>


        <button
          data-stop
          style="
            width:100%;
            margin-top:10px;
            border:1px solid #ef4444;
            border-radius:9px;
            padding:10px;
            background:#7f1d1d;
            color:#fff;
            font-weight:700;
            cursor:pointer;
          "
        >
          지금까지 저장하고 중단
        </button>


        <button
          data-reopen
          style="
            display:none;
            width:100%;
            margin-top:10px;
            border:0;
            border-radius:9px;
            padding:10px;
            background:#fff;
            color:#111827;
            font-weight:700;
            cursor:pointer;
          "
        >
          새 수집창 열고 계속
        </button>


        <div
          data-actions
          style="
            display:none;
            gap:8px;
            margin-top:12px;
          "
        >
          <button
            data-save
            style="
              flex:1;
              border:0;
              border-radius:9px;
              padding:9px 10px;
              background:#fff;
              color:#111827;
              font-weight:700;
              cursor:pointer;
            "
          >
            TXT 저장
          </button>

          <button
            data-reset
            style="
              border:1px solid #4b5563;
              border-radius:9px;
              padding:9px 12px;
              background:transparent;
              color:#fff;
              cursor:pointer;
            "
          >
            기록 삭제
          </button>
        </div>

      </div>
    `;


    document.documentElement
      .appendChild(root);


    root
      .querySelector(
        "[data-close]"
      )
      .onclick =
      () => root.remove();


    return {
      root,

      title:
        root.querySelector(
          "[data-title]"
        ),

      bar:
        root.querySelector(
          "[data-bar]"
        ),

      status:
        root.querySelector(
          "[data-status]"
        ),

      auth:
        root.querySelector(
          "[data-auth]"
        ),

      stop:
        root.querySelector(
          "[data-stop]"
        ),

      reopen:
        root.querySelector(
          "[data-reopen]"
        ),

      actions:
        root.querySelector(
          "[data-actions]"
        ),

      save:
        root.querySelector(
          "[data-save]"
        ),

      reset:
        root.querySelector(
          "[data-reset]"
        )
    };
  }


  /*
    이어받기 기록
  */
  function saveResumeState(state) {
    try {
      localStorage.setItem(
        RESUME_KEY,
        JSON.stringify(state)
      );
    } catch (_) {}
  }


  function loadResumeState() {
    try {
      const raw =
        localStorage.getItem(
          RESUME_KEY
        );

      return raw
        ? JSON.parse(raw)
        : null;

    } catch (_) {
      return null;
    }
  }


  function clearResumeState() {
    try {
      localStorage.removeItem(
        RESUME_KEY
      );
    } catch (_) {}
  }


  async function fetchDocument(url) {
    const res =
      await fetch(
        url,
        {
          credentials:
            "same-origin",

          cache:
            "no-store",

          headers: {
            Accept:
              "text/html,application/xhtml+xml"
          }
        }
      );


    if (!res.ok) {
      throw new Error(
        `목록 페이지 요청 실패: HTTP ${res.status}`
      );
    }


    return new DOMParser()
      .parseFromString(
        await res.text(),
        "text/html"
      );
  }


  async function collectAllEpisodes(ui) {
    const map =
      new Map();


    const lastPage =
      detectLastListPage(
        document
      );


    for (
      const ep of
      parseEpisodes(document)
    ) {
      map.set(
        ep.number,
        ep
      );
    }


    for (
      let page = 2;
      page <= lastPage;
      page++
    ) {
      if (stopRequested) {
        throw createUserStoppedError();
      }


      ui.status.textContent =
        `회차 목록 확인 중... ${page}/${lastPage}`;


      const doc =
        await fetchDocument(
          `${location.pathname}?epage=${page}`
        );


      for (
        const ep of
        parseEpisodes(doc)
      ) {
        map.set(
          ep.number,
          ep
        );
      }
    }


    return [
      ...map.values()
    ].sort(
      (a, b) =>
        a.number -
        b.number
    );
  }


  /*
    CAPTCHA / 로그인 / 인증 / 접근 확인

    이런 화면은 자동 창 교체 대상으로 처리하지 않고
    사용자가 직접 완료할 때까지 기다림.
  */
  function findAuthReason(
    win,
    doc
  ) {
    let hay = "";


    try {
      hay =
        `${doc?.title || ""}\n` +
        `${
          (
            doc?.body?.innerText ||
            ""
          ).slice(
            0,
            20000
          )
        }\n` +
        `${win?.location?.href || ""}`;

    } catch (_) {}


    if (
      /\b403\b|forbidden|access\s*denied/i
        .test(hay)
    ) {
      return "403 / 접근 확인";
    }


    if (
      /captcha|캡차|자동\s*입력\s*방지|로봇이\s*아닙니다|사람인지\s*확인/i
        .test(hay)
    ) {
      return "CAPTCHA / 사람 확인";
    }


    if (
      /본문\s*보안\s*검증에\s*실패|광고\s*검증\s*후\s*다시|일일\s*조회\s*인증이\s*필요/i
        .test(hay)
    ) {
      return "본문 보안/조회 인증";
    }


    if (
      /로그인이\s*필요합니다/i
        .test(hay)
    ) {
      return "로그인";
    }


    return "";
  }


  function sameEpisode(
    win,
    episodeUrl
  ) {
    try {
      const current =
        new URL(
          win.location.href
        );

      const expected =
        new URL(
          episodeUrl
        );

      return (
        current.origin ===
          expected.origin &&
        current.pathname ===
          expected.pathname
      );

    } catch (_) {
      return false;
    }
  }


  /*
    수집창 새로 열기 시도
  */
  function tryOpenCollector() {
    if (stopRequested) {
      return false;
    }


    try {
      const win =
        window.open(
          "about:blank",
          "novelBackupCollector"
        );


      if (
        win &&
        !win.closed
      ) {
        collectorWin =
          win;

        window.__novelBackupWin =
          win;

        return true;
      }

    } catch (_) {}


    return false;
  }


  /*
    수집창이 없으면 새로 준비.

    자동 window.open()이 팝업 차단되면
    '새 수집창 열고 계속' 버튼 표시.

    그 상태에서 중단 버튼을 누르면
    Promise도 바로 끝남.
  */
  async function ensureCollectorWindow(
    ui
  ) {
    if (stopRequested) {
      return false;
    }


    if (
      collectorWin &&
      !collectorWin.closed
    ) {
      return true;
    }


    ui.status.textContent =
      "새 수집창을 준비하는 중...";


    if (
      tryOpenCollector()
    ) {
      ui.reopen.style.display =
        "none";

      return true;
    }


    if (stopRequested) {
      return false;
    }


    ui.status.textContent =
      "새 수집창을 자동으로 열 수 없습니다.\n" +
      "아래 버튼을 한 번 눌러 주세요.";


    ui.reopen.style.display =
      "block";


    return await new Promise(resolve => {
      let settled = false;


      const finish = value => {
        if (settled) {
          return;
        }

        settled = true;

        stopWaiters.delete(
          stopHandler
        );

        resolve(value);
      };


      const stopHandler = () => {
        ui.reopen.style.display =
          "none";

        finish(false);
      };


      stopWaiters.add(
        stopHandler
      );


      ui.reopen.onclick = () => {
        if (stopRequested) {
          finish(false);
          return;
        }


        if (
          tryOpenCollector()
        ) {
          ui.reopen.style.display =
            "none";

          finish(true);

        } else {
          alert(
            "새 창을 열 수 없습니다.\n" +
            "이 사이트의 팝업을 허용해 주세요."
          );
        }
      };
    });
  }


  /*
    정상 20화 주기 창 교체
  */
  async function rotateCollectorWindow(
    ui,
    completedEpisode
  ) {
    if (stopRequested) {
      throw createUserStoppedError();
    }


    ui.status.textContent =
      `${completedEpisode}화까지 완료\n` +
      `${ROTATE_EVERY_EPISODES}개 회차 수집 완료 → 수집창 교체 중...`;


    try {
      if (
        collectorWin &&
        !collectorWin.closed
      ) {
        collectorWin.close();
      }
    } catch (_) {}


    collectorWin =
      null;

    window.__novelBackupWin =
      null;


    await sleep(
      800
    );


    if (stopRequested) {
      throw createUserStoppedError();
    }


    const ok =
      await ensureCollectorWindow(
        ui
      );


    if (
      !ok ||
      stopRequested
    ) {
      throw createUserStoppedError();
    }


    ui.status.textContent =
      `${completedEpisode}화까지 완료\n` +
      `새 수집창 준비 완료`;


    await sleep(
      600
    );
  }


  /*
    회차 한 개 수집
  */
  async function loadEpisodeTextOnce(
    episode,
    ui
  ) {
    if (stopRequested) {
      throw createUserStoppedError();
    }


    const ok =
      await ensureCollectorWindow(
        ui
      );


    if (!ok) {
      if (stopRequested) {
        throw createUserStoppedError();
      }

      throw Object.assign(
        new Error(
          `${episode.number}화: 수집창을 열 수 없습니다.`
        ),
        {
          recoverable: true
        }
      );
    }


    return new Promise(
      (resolve, reject) => {

        let finished =
          false;

        let waitingForManualAuth =
          false;

        let authStartedAt =
          null;

        const startedAt =
          Date.now();

        let timer =
          null;


        function finish(
          fn,
          value
        ) {
          if (finished) {
            return;
          }


          finished =
            true;


          if (timer) {
            clearInterval(
              timer
            );
          }


          ui.auth.style.display =
            "none";

          ui.auth.textContent =
            "";


          fn(value);
        }


        /*
          회차 이동
        */
        try {
          collectorWin.location.href =
            episode.url;

          collectorWin.focus();

        } catch (_) {
          finish(
            reject,

            Object.assign(
              new Error(
                `${episode.number}화: 수집창 이동 실패`
              ),
              {
                recoverable: true
              }
            )
          );

          return;
        }


        timer =
          setInterval(
            () => {

              /*
                사용자가 중단 버튼을 누른 경우
              */
              if (stopRequested) {
                finish(
                  reject,
                  createUserStoppedError()
                );

                return;
              }


              /*
                수집창을 실수로 닫은 경우
              */
              if (
                !collectorWin ||
                collectorWin.closed
              ) {
                finish(
                  reject,

                  Object.assign(
                    new Error(
                      `${episode.number}화: 수집창이 닫혔습니다.`
                    ),
                    {
                      recoverable: true
                    }
                  )
                );

                return;
              }


              try {
                const doc =
                  collectorWin.document;


                const authReason =
                  findAuthReason(
                    collectorWin,
                    doc
                  );


                /*
                  인증 / CAPTCHA / 접근 확인

                  자동 새창 교체하지 않고
                  직접 완료 대기
                */
                if (authReason) {
                  if (
                    !waitingForManualAuth
                  ) {
                    waitingForManualAuth =
                      true;

                    authStartedAt =
                      Date.now();


                    ui.status.textContent =
                      `${episode.number}화에서 인증이 필요합니다.`;


                    ui.auth.style.display =
                      "block";


                    ui.auth.textContent =
                      `⚠️ ${authReason}\n\n` +
                      `수집창에서 직접 확인을 완료해 주세요.\n` +
                      `완료되면 같은 회차부터 자동으로 이어집니다.`;


                    try {
                      collectorWin.focus();
                    } catch (_) {}
                  }


                  if (
                    authStartedAt &&
                    Date.now() -
                      authStartedAt >
                    MANUAL_AUTH_TIMEOUT_MS
                  ) {
                    finish(
                      reject,

                      new Error(
                        `${episode.number}화: 인증 대기 시간이 10분을 초과했습니다.`
                      )
                    );
                  }


                  return;
                }


                /*
                  인증 화면이 사라짐
                */
                if (
                  waitingForManualAuth
                ) {
                  ui.status.textContent =
                    `${episode.number}화 인증 완료 확인 중...`;

                  ui.auth.textContent =
                    `✅ 확인 화면이 사라졌습니다.\n` +
                    `본문을 기다리는 중...`;
                }


                /*
                  아직 목표 회차에 도착하지 않았으면 기다림
                */
                if (
                  !sameEpisode(
                    collectorWin,
                    episode.url
                  )
                ) {
                  return;
                }


                /*
                  정상 본문
                */
                const text =
                  collectorWin.__novelTTSText;


                if (
                  typeof text ===
                    "string" &&
                  text.trim().length >
                    0
                ) {
                  finish(
                    resolve,

                    String(text)
                      .replace(
                        /\r\n?/g,
                        "\n"
                      )
                      .replace(
                        /\n{3,}/g,
                        "\n\n"
                      )
                      .trim()
                  );

                  return;
                }


                const contentHost =
                  doc.querySelector(
                    "[data-theme-novel-content]"
                  );


                const visibleMessage =
                  contentHost
                    ?.textContent
                    ?.trim() ||
                  "";


                /*
                  일반 로딩 실패

                  인증 상태가 아닌 경우에만
                  자동복구 대상으로 처리
                */
                if (
                  visibleMessage &&
                  !/본문\s*불러오는\s*중/i
                    .test(
                      visibleMessage
                    ) &&
                  /실패|오류|준비되지\s*않았습니다/i
                    .test(
                      visibleMessage
                    ) &&
                  !waitingForManualAuth
                ) {
                  finish(
                    reject,

                    Object.assign(
                      new Error(
                        `${episode.number}화: ${visibleMessage}`
                      ),
                      {
                        recoverable:
                          true
                      }
                    )
                  );

                  return;
                }


                /*
                  일반 timeout
                */
                if (
                  !waitingForManualAuth &&
                  Date.now() -
                    startedAt >
                    NORMAL_TIMEOUT_MS
                ) {
                  finish(
                    reject,

                    Object.assign(
                      new Error(
                        `${episode.number}화: ` +
                        `${Math.round(
                          NORMAL_TIMEOUT_MS /
                          1000
                        )}초 동안 본문을 불러오지 못했습니다.`
                      ),
                      {
                        recoverable:
                          true
                      }
                    )
                  );
                }

              } catch (_) {

                /*
                  다른 origin의 확인 화면 등으로
                  document 접근이 안 되는 경우.

                  인증/확인 가능성이 있으므로
                  자동으로 새 창을 갈아치우지 않고
                  사용자가 직접 완료할 때까지 대기.
                */
                if (
                  !waitingForManualAuth
                ) {
                  waitingForManualAuth =
                    true;

                  authStartedAt =
                    Date.now();


                  ui.status.textContent =
                    `${episode.number}화에서 추가 확인이 필요합니다.`;


                  ui.auth.style.display =
                    "block";


                  ui.auth.textContent =
                    `⚠️ 인증/확인 화면이 열렸을 수 있습니다.\n\n` +
                    `수집창에서 직접 완료해 주세요.`;
                }


                if (
                  authStartedAt &&
                  Date.now() -
                    authStartedAt >
                    MANUAL_AUTH_TIMEOUT_MS
                ) {
                  finish(
                    reject,

                    new Error(
                      `${episode.number}화: 인증 대기 시간이 10분을 초과했습니다.`
                    )
                  );
                }
              }

            },
            POLL_MS
          );
      }
    );
  }


  /*
    창 실수로 닫힘 / 일반 로딩 오류 등은
    새 창으로 같은 회차부터 다시 시도

    사용자가 중단 버튼을 누른 경우에는
    절대 자동복구하지 않음.
  */
  async function loadEpisodeWithRecovery(
    episode,
    ui
  ) {
    let attempt = 0;


    while (true) {
      if (stopRequested) {
        throw createUserStoppedError();
      }


      try {
        return await loadEpisodeTextOnce(
          episode,
          ui
        );

      } catch (err) {

        /*
          사용자 중단은 즉시 종료
        */
        if (
          err?.userStopped ||
          stopRequested
        ) {
          throw createUserStoppedError();
        }


        /*
          복구 불가능 오류 또는
          최대 재시도 횟수 초과
        */
        if (
          !err?.recoverable ||
          attempt >=
            MAX_RECOVERY_RETRIES
        ) {
          throw err;
        }


        attempt++;


        ui.status.textContent =
          `${episode.number}화 수집이 중단되었습니다.\n` +
          `새 수집창으로 복구 중... ` +
          `(${attempt}/${MAX_RECOVERY_RETRIES})`;


        /*
          기존 창 정리
        */
        try {
          if (
            collectorWin &&
            !collectorWin.closed
          ) {
            collectorWin.close();
          }
        } catch (_) {}


        collectorWin =
          null;

        window.__novelBackupWin =
          null;


        await sleep(
          700
        );


        /*
          다음 반복에서
          같은 episode를 다시 받음
        */
      }
    }
  }


  /*
    TXT 생성
  */
  function buildTxt(
    workTitle,
    chapters,
    actualStart,
    actualEnd
  ) {
    const lines = [];


    lines.push(
      `${workTitle}_${actualStart}~${actualEnd}화`
    );

    lines.push("");
    lines.push("");


    for (
      const ch of chapters
    ) {
      lines.push(
        `##${ch.number}화`
      );

      lines.push("");

      lines.push(
        ch.text
      );

      lines.push("");
      lines.push("");
    }


    return lines.join(
      "\n"
    );
  }


  /*
    TXT 다운로드
  */
  function prepareTxtDownload(
    ui,
    filename,
    text
  ) {
    const blob =
      new Blob(
        [
          "\uFEFF",
          text
        ],
        {
          type:
            "text/plain;charset=utf-8"
        }
      );


    const objectUrl =
      URL.createObjectURL(
        blob
      );


    function save() {
      const a =
        document.createElement(
          "a"
        );


      a.href =
        objectUrl;

      a.download =
        filename;

      a.rel =
        "noopener";


      document.body
        .appendChild(
          a
        );

      a.click();

      a.remove();
    }


    ui.actions.style.display =
      "flex";


    ui.save.onclick =
      save;


    /*
      가능하면 자동 다운로드
      브라우저가 막으면 TXT 저장 버튼 사용
    */
    try {
      save();
    } catch (_) {}


    setTimeout(
      () => {
        URL.revokeObjectURL(
          objectUrl
        );
      },
      10 * 60 * 1000
    );
  }


  async function main() {
    const ui =
      createOverlay();


    const workTitle =
      getWorkTitle();


    ui.title.textContent =
      workTitle;


    /*
      중단 버튼

      현재 받는 중인 회차는 저장하지 않고,
      직전까지 완전히 완료된 회차만 TXT에 넣음.
    */
    ui.stop.onclick =
      () => {

        if (stopRequested) {
          return;
        }


        const ok =
          confirm(
            "수집을 여기서 중단하고\n" +
            "완전히 저장된 회차까지만 TXT로 받을까요?"
          );


        if (!ok) {
          return;
        }


        stopRequested =
          true;


        ui.stop.disabled =
          true;


        ui.stop.textContent =
          "중단 중...";


        ui.reopen.style.display =
          "none";


        ui.auth.style.display =
          "none";


        ui.status.textContent =
          "현재 수집을 중단하는 중...\n" +
          "완전히 저장된 회차까지만 TXT로 준비합니다.";


        /*
          팝업 열기 버튼 등을 기다리는 Promise도
          즉시 중단시킴
        */
        notifyStopWaiters();


        /*
          현재 받고 있던 수집창도 닫음.

          stopRequested=true이므로
          자동복구는 실행되지 않음.
        */
        try {
          if (
            collectorWin &&
            !collectorWin.closed
          ) {
            collectorWin.close();
          }
        } catch (_) {}


        collectorWin =
          null;

        window.__novelBackupWin =
          null;
      };


    /*
      최초 수집창 확보
    */
    const initialCollector =
      await ensureCollectorWindow(
        ui
      );


    if (
      !initialCollector &&
      stopRequested
    ) {
      ui.status.textContent =
        "수집을 중단했습니다.\n" +
        "아직 완료된 회차가 없어 저장할 TXT가 없습니다.";

      ui.stop.style.display =
        "none";

      return;
    }


    /*
      전체 회차 목록
    */
    let allEpisodes;


    try {
      allEpisodes =
        await collectAllEpisodes(
          ui
        );

    } catch (err) {

      if (
        err?.userStopped ||
        stopRequested
      ) {
        ui.status.textContent =
          "수집을 중단했습니다.\n" +
          "아직 완료된 회차가 없어 저장할 TXT가 없습니다.";

        ui.stop.style.display =
          "none";

        return;
      }


      ui.status.textContent =
        err?.message ||
        "회차 목록을 가져오지 못했습니다.";

      return;
    }


    if (!allEpisodes.length) {
      ui.status.textContent =
        "회차 목록을 찾지 못했습니다.";

      return;
    }


    const minEpisode =
      allEpisodes[0].number;


    const maxEpisode =
      allEpisodes[
        allEpisodes.length - 1
      ].number;


    let chapters = [];

    let startEpisode;

    let endEpisode;

    let successfulSinceRotation =
      0;


    /*
      이전 기록 복구
    */
    const resume =
      loadResumeState();


    if (
      resume &&
      resume.path ===
        location.pathname &&
      Array.isArray(
        resume.chapters
      ) &&
      Number.isInteger(
        resume.nextEpisode
      ) &&
      Number.isInteger(
        resume.endEpisode
      )
    ) {
      const useResume =
        confirm(
          `이전 백업 기록이 있습니다.\n\n` +
          `${resume.nextEpisode}화부터 ` +
          `${resume.endEpisode}화까지 이어받을까요?\n\n` +
          `현재 저장 완료: ` +
          `${resume.chapters.length}개 회차`
        );


      if (useResume) {
        chapters =
          resume.chapters;


        startEpisode =
          resume.nextEpisode;


        endEpisode =
          resume.endEpisode;


        successfulSinceRotation =
          Number.isInteger(
            resume.successfulSinceRotation
          )
            ? resume.successfulSinceRotation
            : 0;

      } else {
        clearResumeState();
      }
    }


    /*
      새 작업 범위 선택
    */
    if (
      !Number.isInteger(
        startEpisode
      )
    ) {
      const startRaw =
        prompt(
          `몇 화부터 받을까요?\n` +
          `가능 범위: ${minEpisode} ~ ${maxEpisode}`,
          String(
            minEpisode
          )
        );


      if (
        startRaw === null
      ) {
        return;
      }


      const endRaw =
        prompt(
          `몇 화까지 받을까요?\n` +
          `가능 범위: ${minEpisode} ~ ${maxEpisode}`,
          String(
            maxEpisode
          )
        );


      if (
        endRaw === null
      ) {
        return;
      }


      startEpisode =
        Number(
          String(
            startRaw
          ).trim()
        );


      endEpisode =
        Number(
          String(
            endRaw
          ).trim()
        );


      if (
        !Number.isInteger(
          startEpisode
        ) ||
        !Number.isInteger(
          endEpisode
        )
      ) {
        ui.status.textContent =
          "화수는 숫자로 입력해야 합니다.";

        return;
      }


      if (
        startEpisode >
        endEpisode
      ) {
        [
          startEpisode,
          endEpisode
        ] = [
          endEpisode,
          startEpisode
        ];
      }


      startEpisode =
        Math.max(
          startEpisode,
          minEpisode
        );


      endEpisode =
        Math.min(
          endEpisode,
          maxEpisode
        );


      successfulSinceRotation =
        0;
    }


    const targets =
      allEpisodes.filter(
        ep =>
          ep.number >=
            startEpisode &&
          ep.number <=
            endEpisode
      );


    if (!targets.length) {
      ui.status.textContent =
        "해당 범위에 회차가 없습니다.";

      return;
    }


    /*
      실제 회차 수집
    */
    for (
      let i = 0;
      i < targets.length;
      i++
    ) {
      const ep =
        targets[i];


      if (stopRequested) {
        break;
      }


      /*
        진행률
      */
      const originalStart =
        chapters.length
          ? chapters[0].number
          : startEpisode;


      const totalExpected =
        Math.max(
          1,
          endEpisode -
            originalStart +
            1
        );


      const completed =
        chapters.length;


      ui.bar.style.width =
        `${
          Math.min(
            100,
            Math.round(
              (
                completed /
                totalExpected
              ) * 100
            )
          )
        }%`;


      ui.status.textContent =
        `${ep.number}화 받는 중...\n` +
        `이번 수집창: ` +
        `${successfulSinceRotation}/` +
        `${ROTATE_EVERY_EPISODES}`;


      try {
        const text =
          await loadEpisodeWithRecovery(
            ep,
            ui
          );


        /*
          중단 요청이 본문 반환 직전에 들어온 경우도
          현재 화를 저장하지 않음.
        */
        if (stopRequested) {
          break;
        }


        /*
          여기까지 왔을 때만
          해당 회차가 완전히 저장된 것으로 인정
        */
        chapters.push({
          number:
            ep.number,

          title:
            ep.title,

          text
        });


        successfulSinceRotation++;


        /*
          매 회차 성공 시 진행상황 저장
        */
        saveResumeState({
          path:
            location.pathname,

          workTitle,

          nextEpisode:
            ep.number + 1,

          endEpisode,

          successfulSinceRotation,

          chapters
        });


        /*
          마지막 화가 아니면서
          현재 수집창에서 20개 회차를 정상적으로
          완료했으면 수집창 교체
        */
        const hasMoreEpisodes =
          i <
          targets.length - 1;


        if (
          hasMoreEpisodes &&
          successfulSinceRotation >=
            ROTATE_EVERY_EPISODES
        ) {
          await rotateCollectorWindow(
            ui,
            ep.number
          );


          successfulSinceRotation =
            0;


          /*
            창 교체 후 counter 초기화 상태 저장
          */
          saveResumeState({
            path:
              location.pathname,

            workTitle,

            nextEpisode:
              ep.number + 1,

            endEpisode,

            successfulSinceRotation,

            chapters
          });
        }

      } catch (err) {

        /*
          사용자가 중단 버튼을 누른 경우
          finalization 단계로 이동
        */
        if (
          err?.userStopped ||
          stopRequested
        ) {
          break;
        }


        /*
          일반 오류
        */
        ui.status.innerHTML =
          `<b>${ep.number}화에서 중단됨</b><br>` +
          `${escapeHtml(
            err?.message ||
            String(err)
          )}<br>` +
          `진행상황은 저장되어 있습니다.`;

        return;
      }


      if (stopRequested) {
        break;
      }


      await sleep(
        BETWEEN_EPISODES_MS
      );
    }


    /*
      완전히 저장된 회차 기준 정렬
    */
    chapters.sort(
      (a, b) =>
        a.number -
        b.number
    );


    /*
      한 화도 완료되지 않은 상태에서
      중단한 경우
    */
    if (!chapters.length) {
      ui.status.textContent =
        stopRequested
          ? (
              "수집을 중단했습니다.\n" +
              "아직 완료된 회차가 없어 " +
              "저장할 TXT가 없습니다."
            )
          : "저장할 본문이 없습니다.";


      ui.stop.style.display =
        "none";


      clearResumeState();


      return;
    }


    const actualStart =
      chapters[0].number;


    const actualEnd =
      chapters[
        chapters.length - 1
      ].number;


    const txt =
      buildTxt(
        workTitle,
        chapters,
        actualStart,
        actualEnd
      );


    const filename =
      sanitizeFilename(
        `${workTitle}_${actualStart}~${actualEnd}화.txt`
      );


    /*
      사용자 중단이든 정상 완료든
      지금 TXT를 만들어 받는 것이므로
      임시 이어받기 기록 제거
    */
    clearResumeState();


    ui.bar.style.width =
      stopRequested
        ? ui.bar.style.width
        : "100%";


    ui.stop.style.display =
      "none";


    ui.reopen.style.display =
      "none";


    ui.auth.style.display =
      "none";


    if (stopRequested) {
      ui.status.innerHTML =
        `<b>수집을 중단했습니다.</b><br>` +
        `${actualStart}~${actualEnd}화까지 저장 완료<br>` +
        `${chapters.length}개 회차를 TXT로 준비했습니다.`;

    } else {
      ui.status.innerHTML =
        `<b>${actualStart}~${actualEnd}화 완료</b><br>` +
        `${chapters.length}개 회차를 TXT로 준비했습니다.`;
    }


    ui.reset.onclick =
      () => {
        clearResumeState();

        ui.status.textContent +=
          "\n이어받기 기록을 삭제했습니다.";
      };


    prepareTxtDownload(
      ui,
      filename,
      txt
    );


    /*
      남아있는 수집창 종료
    */
    try {
      if (
        collectorWin &&
        !collectorWin.closed
      ) {
        collectorWin.close();
      }
    } catch (_) {}


    collectorWin =
      null;

    window.__novelBackupWin =
      null;
  }


  main()
    .catch(err => {

      console.error(err);


      if (
        err?.userStopped ||
        stopRequested
      ) {
        return;
      }


      alert(
        err?.message ||
        String(err)
      );

    });

})();
