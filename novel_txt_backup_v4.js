(() => {
  "use strict";

  const APP_ID = "novel-txt-backup-overlay-v6-2";

  const POLL_MS = 400;
  const NORMAL_TIMEOUT_MS = 45000;
  const MANUAL_AUTH_TIMEOUT_MS = 10 * 60 * 1000;
  const BETWEEN_EPISODES_MS = 900;

  // 정상 수집 20화마다 수집창 교체
  const ROTATE_EVERY_EPISODES = 20;

  // 창 실수로 닫힘 / 일시적 로딩 실패 시 재시도 횟수
  const MAX_RECOVERY_RETRIES = 2;

  const RESUME_KEY =
    `novelTxtBackupV62:${location.pathname}`;


  /*
    전역 상태
  */
  let collectorWin =
    window.__novelBackupWin || null;

  let stopRequested = false;
  let finalized = false;

  let currentChapters = [];
  let currentWorkTitle = "";
  let currentUi = null;

  let successfulSinceRotation = 0;

  let activeFetchController = null;

  /*
    팝업 허용 버튼을 기다리는 Promise를
    중단 버튼으로 깨우기 위함
  */
  const stopWaiters =
    new Set();


  /*
    작품 목록 페이지 확인
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


  const sleep = ms =>
    new Promise(resolve =>
      setTimeout(resolve, ms)
    );


  function makeUserStoppedError() {
    return Object.assign(
      new Error(
        "사용자가 수집을 중단했습니다."
      ),
      {
        userStopped: true
      }
    );
  }


  function notifyStopWaiters() {
    for (const fn of stopWaiters) {
      try {
        fn();
      } catch (_) {}
    }

    stopWaiters.clear();
  }


  function sanitizeFilename(value) {
    return String(value || "novel")
      .replace(
        /[\\/:*?"<>|]/g,
        "_"
      )
      .replace(
        /\s+/g,
        " "
      )
      .trim()
      .slice(
        0,
        150
      );
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

        max =
          Math.max(
            max,
            parseEpisodePage(
              a.href
            )
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
          number:
            num,

          title:
            (
              a.textContent ||
              `${num}화`
            )
              .trim()
              .replace(
                /\s+/g,
                " "
              ),

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
    진행 UI
  */
  function createOverlay() {
    const root =
      document.createElement(
        "div"
      );


    root.id =
      APP_ID;


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
            TXT 백업 v6.2
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

              transition:
                width .15s linear;
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

            border:
              1px solid #ef4444;

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
            TXT 다시 저장
          </button>


          <button
            data-reset
            style="
              border:
                1px solid #4b5563;

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

    } catch (_) {
      /*
        localStorage 용량 초과 등은
        수집 자체를 막지 않음.
      */
    }
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


  /*
    목록 페이지 fetch

    중단 버튼을 누르면 Abort 가능
  */
  async function fetchDocument(url) {
    if (stopRequested) {
      throw makeUserStoppedError();
    }


    const controller =
      new AbortController();


    activeFetchController =
      controller;


    try {
      const res =
        await fetch(
          url,
          {
            credentials:
              "same-origin",

            cache:
              "no-store",

            signal:
              controller.signal,

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


      const html =
        await res.text();


      return new DOMParser()
        .parseFromString(
          html,
          "text/html"
        );

    } catch (err) {

      if (
        stopRequested ||
        err?.name === "AbortError"
      ) {
        throw makeUserStoppedError();
      }


      throw err;

    } finally {

      if (
        activeFetchController ===
        controller
      ) {
        activeFetchController =
          null;
      }
    }
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
        throw makeUserStoppedError();
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
    인증 / CAPTCHA / 로그인 / 접근 확인
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
            doc?.body
              ?.innerText ||
            ""
          ).slice(
            0,
            20000
          )
        }\n` +

        `${
          win?.location
            ?.href ||
          ""
        }`;

    } catch (_) {}


    if (
      /\b403\b|forbidden|access\s*denied/i
        .test(hay)
    ) {
      return (
        "403 / 접근 확인"
      );
    }


    if (
      /captcha|캡차|자동\s*입력\s*방지|로봇이\s*아닙니다|사람인지\s*확인/i
        .test(hay)
    ) {
      return (
        "CAPTCHA / 사람 확인"
      );
    }


    if (
      /본문\s*보안\s*검증에\s*실패|광고\s*검증\s*후\s*다시|일일\s*조회\s*인증이\s*필요/i
        .test(hay)
    ) {
      return (
        "본문 보안/조회 인증"
      );
    }


    if (
      /로그인이\s*필요합니다/i
        .test(hay)
    ) {
      return (
        "로그인"
      );
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
    새 수집창 열기
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


    /*
      자동 팝업 시도
    */
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


    /*
      Safari 등이 자동 팝업을 막으면
      사용자 버튼 클릭
    */
    ui.status.textContent =
      "새 수집창을 자동으로 열 수 없습니다.\n" +
      "아래 버튼을 한 번 눌러 주세요.";


    ui.reopen.style.display =
      "block";


    return await new Promise(
      resolve => {

        let settled =
          false;


        const finish =
          value => {

            if (settled) {
              return;
            }


            settled =
              true;


            stopWaiters.delete(
              stopHandler
            );


            resolve(
              value
            );
          };


        const stopHandler =
          () => {

            ui.reopen.style.display =
              "none";


            finish(
              false
            );
          };


        stopWaiters.add(
          stopHandler
        );


        ui.reopen.onclick =
          () => {

            if (stopRequested) {
              finish(false);
              return;
            }


            if (
              tryOpenCollector()
            ) {
              ui.reopen.style.display =
                "none";


              finish(
                true
              );

            } else {

              alert(
                "새 창을 열 수 없습니다.\n" +
                "이 사이트의 팝업을 허용해 주세요."
              );

            }
          };

      }
    );
  }


  /*
    20화마다 정상적인 수집창 교체
  */
  async function rotateCollectorWindow(
    ui,
    completedEpisode
  ) {
    if (stopRequested) {
      throw makeUserStoppedError();
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
      throw makeUserStoppedError();
    }


    const ok =
      await ensureCollectorWindow(
        ui
      );


    if (
      !ok ||
      stopRequested
    ) {
      throw makeUserStoppedError();
    }


    ui.status.textContent =
      `${completedEpisode}화까지 완료\n` +
      `새 수집창 준비 완료`;


    await sleep(
      600
    );
  }


  /*
    한 화 수집
  */
  async function loadEpisodeTextOnce(
    episode,
    ui
  ) {
    if (stopRequested) {
      throw makeUserStoppedError();
    }


    const ok =
      await ensureCollectorWindow(
        ui
      );


    if (!ok) {

      if (stopRequested) {
        throw makeUserStoppedError();
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


          fn(
            value
          );
        }


        /*
          목표 회차로 이동
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
                중단 버튼
              */
              if (stopRequested) {

                finish(
                  reject,
                  makeUserStoppedError()
                );


                return;
              }


              /*
                수집창 실수로 닫음
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
                      recoverable:
                        true
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
                  인증 화면은
                  자동 창 교체하지 않음
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
                  인증 완료 후
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
                  collectorWin
                    .__novelTTSText;


                if (
                  typeof text ===
                    "string" &&

                  text
                    .trim()
                    .length >
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
                  타임아웃
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
                  다른 origin 인증 화면 등

                  자동 교체하지 않고
                  사용자가 직접 처리할 때까지 기다림.
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
    창을 실수로 닫았거나
    일반적인 로딩 실패라면
    같은 화부터 자동 재시도
  */
  async function loadEpisodeWithRecovery(
    episode,
    ui
  ) {
    let attempt = 0;


    while (true) {

      if (stopRequested) {
        throw makeUserStoppedError();
      }


      try {
        return await loadEpisodeTextOnce(
          episode,
          ui
        );

      } catch (err) {

        /*
          사용자 중단은
          자동복구 금지
        */
        if (
          err?.userStopped ||
          stopRequested
        ) {
          throw makeUserStoppedError();
        }


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
      }
    }
  }


  /*
    TXT 만들기
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
    TXT 다운로드 준비 + 즉시 다운로드
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
      자동 다운로드
    */
    save();


    /*
      버튼으로 다시 저장할 시간을 위해
      URL은 바로 없애지 않음
    */
    setTimeout(
      () => {
        URL.revokeObjectURL(
          objectUrl
        );
      },
      10 * 60 * 1000
    );
  }


  /*
    ★ v6.2 핵심

    루프 종료를 기다리지 않고
    현재까지 완전히 수집된 회차를
    바로 TXT로 만들어 다운로드
  */
  function finalizePartialImmediately() {
    if (finalized) {
      return;
    }


    finalized =
      true;


    stopRequested =
      true;


    const ui =
      currentUi;


    /*
      현재 fetch가 있으면 즉시 취소
    */
    try {
      if (activeFetchController) {
        activeFetchController.abort();
      }
    } catch (_) {}


    activeFetchController =
      null;


    /*
      팝업 대기 Promise 깨우기
    */
    notifyStopWaiters();


    /*
      현재 수집창 종료
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


    if (ui) {
      ui.stop.style.display =
        "none";


      ui.reopen.style.display =
        "none";


      ui.auth.style.display =
        "none";
    }


    /*
      아직 완전히 받은 화가 하나도 없음
    */
    if (
      !currentChapters.length
    ) {
      if (ui) {
        ui.status.textContent =
          "수집을 중단했습니다.\n" +
          "아직 완전히 수집된 회차가 없어 " +
          "저장할 TXT가 없습니다.";
      }


      clearResumeState();


      return;
    }


    /*
      마지막까지 정상 완료된 화만 사용
    */
    const chapters =
      [...currentChapters]
        .sort(
          (a, b) =>
            a.number -
            b.number
        );


    const actualStart =
      chapters[0].number;


    const actualEnd =
      chapters[
        chapters.length - 1
      ].number;


    const txt =
      buildTxt(
        currentWorkTitle,
        chapters,
        actualStart,
        actualEnd
      );


    const filename =
      sanitizeFilename(
        `${currentWorkTitle}_${actualStart}~${actualEnd}화.txt`
      );


    /*
      TXT를 받았으므로
      임시 진행 기록 제거
    */
    clearResumeState();


    if (ui) {
      ui.status.innerHTML =
        `<b>수집 중단 완료</b><br>` +
        `${actualStart}~${actualEnd}화까지 저장 완료<br>` +
        `${chapters.length}개 회차를 TXT로 준비했습니다.`;
    }


    prepareTxtDownload(
      ui,
      filename,
      txt
    );
  }


  async function main() {
    const ui =
      createOverlay();


    currentUi =
      ui;


    currentWorkTitle =
      getWorkTitle();


    ui.title.textContent =
      currentWorkTitle;


    /*
      ★ 중단 버튼

      여기서 바로 finalizePartialImmediately() 실행.
      메인 수집 루프가 끝날 때까지 기다리지 않음.
    */
    ui.stop.onclick =
      () => {

        if (
          stopRequested ||
          finalized
        ) {
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


        ui.stop.disabled =
          true;


        ui.stop.textContent =
          "저장 중...";


        /*
          즉시 다운로드
        */
        finalizePartialImmediately();
      };


    /*
      최초 수집창 준비
    */
    const initialCollector =
      await ensureCollectorWindow(
        ui
      );


    if (
      finalized ||
      stopRequested
    ) {
      return;
    }


    if (!initialCollector) {
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
        finalized ||
        stopRequested ||
        err?.userStopped
      ) {
        return;
      }


      ui.status.textContent =
        err?.message ||
        "회차 목록을 가져오지 못했습니다.";


      return;
    }


    if (
      finalized ||
      stopRequested
    ) {
      return;
    }


    if (
      !allEpisodes.length
    ) {
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


    let startEpisode;

    let endEpisode;


    /*
      이전 기록 확인
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


      if (
        finalized ||
        stopRequested
      ) {
        return;
      }


      if (useResume) {
        currentChapters =
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
      새 작업
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
        startRaw === null ||
        finalized ||
        stopRequested
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
        endRaw === null ||
        finalized ||
        stopRequested
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


    if (
      !targets.length
    ) {
      ui.status.textContent =
        "해당 범위에 회차가 없습니다.";


      return;
    }


    /*
      실제 수집
    */
    for (
      let i = 0;
      i < targets.length;
      i++
    ) {
      if (
        stopRequested ||
        finalized
      ) {
        return;
      }


      const ep =
        targets[i];


      const originalStart =
        currentChapters.length
          ? currentChapters[0].number
          : startEpisode;


      const totalExpected =
        Math.max(
          1,
          endEpisode -
            originalStart +
            1
        );


      ui.bar.style.width =
        `${
          Math.min(
            100,

            Math.round(
              (
                currentChapters.length /
                totalExpected
              ) *
              100
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
          중단 버튼이 본문 반환 순간 눌렸다면
          이 화는 currentChapters에 넣지 않음.
        */
        if (
          stopRequested ||
          finalized
        ) {
          return;
        }


        /*
          완전히 성공한 화만 저장
        */
        currentChapters.push({
          number:
            ep.number,

          title:
            ep.title,

          text
        });


        successfulSinceRotation++;


        /*
          회차 하나 성공할 때마다
          이어받기 기록 갱신
        */
        saveResumeState({
          path:
            location.pathname,

          workTitle:
            currentWorkTitle,

          nextEpisode:
            ep.number + 1,

          endEpisode,

          successfulSinceRotation,

          chapters:
            currentChapters
        });


        /*
          마지막 회차가 아니고
          20개를 정상 수집했으면
          수집창 교체
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


          if (
            stopRequested ||
            finalized
          ) {
            return;
          }


          successfulSinceRotation =
            0;


          saveResumeState({
            path:
              location.pathname,

            workTitle:
              currentWorkTitle,

            nextEpisode:
              ep.number + 1,

            endEpisode,

            successfulSinceRotation,

            chapters:
              currentChapters
          });
        }

      } catch (err) {

        /*
          사용자가 이미 즉시 저장 완료했다면
          아무것도 더 하지 않음
        */
        if (
          finalized ||
          stopRequested ||
          err?.userStopped
        ) {
          return;
        }


        ui.status.innerHTML =
          `<b>${ep.number}화에서 중단됨</b><br>` +

          `${escapeHtml(
            err?.message ||
            String(err)
          )}<br>` +

          `진행상황은 저장되어 있습니다.`;


        return;
      }


      if (
        stopRequested ||
        finalized
      ) {
        return;
      }


      await sleep(
        BETWEEN_EPISODES_MS
      );
    }


    /*
      정상적으로 끝까지 완료
    */
    if (
      finalized ||
      stopRequested
    ) {
      return;
    }


    currentChapters.sort(
      (a, b) =>
        a.number -
        b.number
    );


    if (
      !currentChapters.length
    ) {
      ui.status.textContent =
        "저장할 본문이 없습니다.";


      return;
    }


    finalized =
      true;


    const actualStart =
      currentChapters[0].number;


    const actualEnd =
      currentChapters[
        currentChapters.length - 1
      ].number;


    const txt =
      buildTxt(
        currentWorkTitle,
        currentChapters,
        actualStart,
        actualEnd
      );


    const filename =
      sanitizeFilename(
        `${currentWorkTitle}_${actualStart}~${actualEnd}화.txt`
      );


    clearResumeState();


    ui.bar.style.width =
      "100%";


    ui.stop.style.display =
      "none";


    ui.reopen.style.display =
      "none";


    ui.auth.style.display =
      "none";


    ui.status.innerHTML =
      `<b>${actualStart}~${actualEnd}화 완료</b><br>` +
      `${currentChapters.length}개 회차를 TXT로 준비했습니다.`;


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
      마지막 수집창 종료
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
    .catch(
      err => {

        console.error(
          err
        );


        if (
          finalized ||
          stopRequested ||
          err?.userStopped
        ) {
          return;
        }


        alert(
          err?.message ||
          String(err)
        );

      }
    );

})();
