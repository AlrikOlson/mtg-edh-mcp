/**
 * A recorded MakePlayingCards stand-in served into a Playwright page through
 * `page.route`. The pages reproduce the element ids, frame name, page JS
 * objects, URLs and navigation order observed on the live site on 2026-10-25
 * (product page selects and `doPersonalize`, the `sysifm_loginFrame` mode
 * frame with `txt_card_number` and `setMode`, the designer's `uploadId` input,
 * `oDesignImage.UploadStatus` and `dn_getImageList`, `PageLayout.prototype`
 * `getElement3` / `applyDragPhoto` over `dnImg<n>_0_0` slots carrying a `pid`,
 * `oDesign.setTemporarySave` with `txt_temporaryname` and
 * `div_temporarysavestatus`, `oDesign.setNextStep` through the text editors to
 * the preview, the blank-design `confirm`, the saved-projects page and the
 * sign-in redirect). The server side keeps the project state the real site
 * keeps, so the adapter's selectors and calls are exercised for real while no
 * network is touched. The saved-projects list markup is the one assumption the
 * live site could not confirm without an account.
 */
import { createHash } from "node:crypto";
import type { Page, Route } from "playwright";

export type FixtureFace = "front" | "back";
export type FixtureStage =
  "front_designer" | "text_front" | "back_designer" | "text_back" | "preview";

export interface FixtureProject {
  ssid: string;
  name: string | null;
  stock: string;
  size: string;
  effect: string;
  quantity: number | null;
  modes: Record<FixtureFace, "same" | "different" | null>;
  slots: Record<FixtureFace, Array<string | null>>;
  uploads: Record<FixtureFace, string[]>;
  saves: number;
}

export interface FixtureDrift {
  /** The product page ships without its stock select. */
  missingStockSelect?: boolean;
  /** Uploads never finish: UploadStatus stays "Uploading". */
  uploadNeverCompletes?: boolean;
}

export interface FixtureOptions {
  signedIn?: boolean;
  projects?: FixtureProject[];
  drift?: FixtureDrift;
}

export interface FixtureState {
  signedIn: boolean;
  readonly projects: Map<string, FixtureProject>;
  /** Every request path the page made, in order. */
  readonly requests: string[];
  readonly drift: FixtureDrift;
}

export const FIXTURE_BASE_URL = "https://www.makeplayingcards.com";

const STOCKS: Array<[string, string]> = [
  ["PA_334", "(S20) Ultra-Thin"],
  ["PA_016", "(S27) Smooth"],
  ["PA_014", "(S30) Standard Smooth"],
  ["PA_059", "(S33) Superior Smooth"],
  ["PA_015", "(M31) Linen"],
  ["PA_017", "(P10) Plastic"],
];
const SIZES = [18, 36, 55, 72, 90, 108, 126, 144, 162, 180, 198, 216, 234, 396, 504, 612];
const EFFECTS: Array<[string, string]> = [
  ["", "Full color print"],
  ["EF_311", "Gold (front)"],
  ["EF_055", "Holographic (front)"],
  ["EF_120", "Holographic (front & back)"],
];

export function newFixtureProject(
  ssid: string,
  init: Partial<FixtureProject> = {},
): FixtureProject {
  return {
    ssid,
    name: null,
    stock: "PA_014",
    size: "18",
    effect: "",
    quantity: null,
    modes: { front: null, back: null },
    slots: { front: [], back: [] },
    uploads: { front: [], back: [] },
    saves: 0,
    ...init,
  };
}

function header(signedIn: boolean): string {
  return signedIn
    ? '<div id="header"><a href="/logout.aspx">Sign out</a> | <a href="/order-status.aspx">Order status</a></div>'
    : '<div id="header"><a href="/login.aspx">Sign in</a> | <a href="/order-status.aspx">Order status</a></div>';
}

function document(title: string, body: string, signedIn: boolean): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${header(signedIn)}${body}</body></html>`;
}

function options(pairs: Array<[string, string]>, selected: string): string {
  return pairs
    .map(
      ([value, text]) =>
        `<option value="${value}"${value === selected ? " selected" : ""}>${text}</option>`,
    )
    .join("");
}

function productPage(state: FixtureState): string {
  const stock = state.drift.missingStockSelect
    ? ""
    : `<select id="dro_paper_type">${options(STOCKS, "PA_014")}</select>`;
  const body = `
    <h1>Custom Game Cards</h1>
    ${stock}
    <select id="dro_choosesize">${options(
      SIZES.map((size) => [String(size), `Up to ${size} cards`]),
      "55",
    )}</select>
    <select id="dro_product_effect">${options(EFFECTS, "")}</select>
    <a href="javascript:doPersonalize('${FIXTURE_BASE_URL}/products/pro_item_process_flow.aspx')">start your design</a>
    <script>
      function doPersonalize(url) {
        var stock = document.getElementById("dro_paper_type");
        var q = "?stock=" + encodeURIComponent(stock ? stock.value : "") +
          "&size=" + encodeURIComponent(document.getElementById("dro_choosesize").value) +
          "&effect=" + encodeURIComponent(document.getElementById("dro_product_effect").value);
        window.location.href = url + q;
      }
    </script>`;
  return document("Custom Game Cards", body, state.signedIn);
}

function modePage(project: FixtureProject, face: FixtureFace): string {
  const count = project.quantity ?? Number(project.size);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Mode</title></head><body>
    <div>Step ${face === "front" ? 1 : 3}: Enter number of cards for your deck (max. ${project.size})</div>
    <input id="txt_card_number" type="text" value="${count}">
    <select id="dro_total_count">${options(
      SIZES.map((size) => [String(size), `Up to ${size} cards`]),
      project.size,
    )}</select>
    <input type="hidden" id="hidd_mode" value="">
    <a href="javascript:setMode('ImageText', 1)">Same for all ${face}s</a>
    <a href="javascript:setMode('ImageText', 0);">Different for all ${face}s</a>
    <script>
      var OriginalCount = ${Number(project.size)};
      function setMode(mode, designCount) {
        var total = parseInt(document.getElementById("txt_card_number").value, 10);
        if (!(total > 0 && total <= OriginalCount)) { alert("The number is invalid!"); return; }
        var body = JSON.stringify({ ssid: ${JSON.stringify(project.ssid)}, face: ${JSON.stringify(face)}, total: total, design: designCount });
        fetch("/fixture/mode", { method: "POST", body: body }).then(function () { window.parent.location.reload(); });
      }
    </script></body></html>`;
}

function designerPage(state: FixtureState, project: FixtureProject, face: FixtureFace): string {
  const path =
    face === "front"
      ? "/products/playingcard/design/dn_playingcards_front_dynamic.aspx"
      : "/products/playingcard/design/dn_playingcards_back_dynamic.aspx";
  const mode = project.modes[face];
  const frame =
    mode === null
      ? `<iframe name="sysifm_loginFrame" id="sysifm_loginFrame" src="/products/playingcard/design/dn_playingcards_mode_${face === "front" ? "nf" : "nb"}.aspx?ssid=${project.ssid}" width="600" height="400"></iframe>`
      : "";
  const slots = project.slots[face]
    .map(
      (pid, index) =>
        `<img id="dnImg${index}_0_0" dytype="dnimage" index="${index}" repeatindex="0" sortno="0" photoindex="${index}"${pid ? ` pid="${pid}" pix="0"` : ""} src="/images/products/default.gif" alt="">`,
    )
    .join("");
  const uploads = project.uploads[face]
    .map(
      (pid) =>
        `<li><img id="upload_${pid}" dytype="userimage" pid="${pid}" pix="0" src="/FileStore/${pid}.png"></li>`,
    )
    .join("");
  const body = `
    ${frame}
    <div id="design">${slots}</div>
    <input id="uploadId" type="file" accept=".jpg,.jpeg,.bmp,.png,.gif,.tif,.tiff" multiple>
    <ul id="ImageUL">${uploads}</ul>
    <input id="txt_temporaryname" type="text" value="Project-${project.ssid.slice(0, 6)}">
    <a href="javascript:oDesign.setTemporarySave();">Save</a>
    <div id="div_temporarysavestatus" style="display:none"></div>
    <a href="javascript:oDesign.setNextStep();">Next</a>
    <div id="sysdiv_wait" style="display:none"></div>
    <script>
      var SSID = ${JSON.stringify(project.ssid)};
      var FACE = ${JSON.stringify(face)};
      var NEVER_COMPLETES = ${state.drift.uploadNeverCompletes ? "true" : "false"};
      function PageLayout() {}
      PageLayout.prototype.IndexObj = ${mode === null ? "null" : JSON.stringify(Object.fromEntries(project.slots[face].map((_, index) => [String(index), { Index: index, RepeatIndex: 0, SortNo: 0 }])))};
      PageLayout.prototype.getElement3 = function (prefixName, photoIndex) {
        var objIndex = PageLayout.prototype.IndexObj[photoIndex];
        if (objIndex == null) return null;
        return document.getElementById(prefixName + objIndex.Index + "_" + objIndex.RepeatIndex + "_" + objIndex.SortNo);
      };
      PageLayout.prototype.applyDragPhoto = function (obj, pid1, pid2) {
        if (obj == null || pid2 == null) return;
        var slot = obj.getAttribute("photoindex");
        fetch("/fixture/place?ssid=" + SSID + "&face=" + FACE + "&slot=" + slot + "&pid=" + pid2, { method: "POST" })
          .then(function (response) { if (response.ok) { obj.setAttribute("pid", pid2); obj.setAttribute("pix", "0"); } });
      };
      var oDesignImage = {
        UploadStatus: "",
        ImageUL: document.getElementById("ImageUL"),
        dn_getImageList: function () {
          var pids = [];
          var imgs = this.ImageUL.getElementsByTagName("IMG");
          for (var i = 0; i < imgs.length; i++) if (imgs[i].id.indexOf("upload_") !== -1) pids.push(imgs[i].getAttribute("pid"));
          return pids.join(";");
        },
      };
      document.getElementById("uploadId").addEventListener("change", function (event) {
        var files = event.target.files;
        if (!files.length) return;
        oDesignImage.UploadStatus = "Uploading";
        if (NEVER_COMPLETES) return;
        var pending = files.length;
        Array.prototype.forEach.call(files, function (file) {
          file.arrayBuffer().then(function (bytes) {
            return fetch("/fixture/upload?ssid=" + SSID + "&face=" + FACE, { method: "POST", body: bytes });
          }).then(function (response) { return response.json(); }).then(function (data) {
            if (!document.getElementById("upload_" + data.pid)) {
              var li = document.createElement("li");
              li.innerHTML = '<img id="upload_' + data.pid + '" dytype="userimage" pid="' + data.pid + '" pix="0" src="/FileStore/' + data.pid + '.png">';
              oDesignImage.ImageUL.appendChild(li);
            }
            pending -= 1;
            if (pending === 0) oDesignImage.UploadStatus = "Complete";
          });
        });
      });
      var oDesign = {
        setTemporarySave: function () {
          var name = document.getElementById("txt_temporaryname").value;
          fetch("/fixture/save?ssid=" + SSID + "&name=" + encodeURIComponent(name), { method: "POST" }).then(function (response) {
            if (!response.ok) return;
            var status = document.getElementById("div_temporarysavestatus");
            status.textContent = "Saved successfully";
            status.style.display = "block";
          });
        },
        setNextStep: function () {
          var imgs = document.querySelectorAll("#design img");
          var empty = 0;
          for (var i = 0; i < imgs.length; i++) if (!imgs[i].getAttribute("pid")) empty += 1;
          if (empty > 0 && !confirm("There are still some blanks in your design! \\n\\n Press OK to continue, or Cancel to stay on the current page.")) return;
          fetch("/fixture/next?ssid=" + SSID + "&from=" + (FACE === "front" ? "front_designer" : "back_designer")).then(function (r) { return r.text(); }).then(function (url) { window.location.href = url; });
        },
      };
      var oTrackerBar = { setFlow: function (url) { window.location.href = url; } };
      window.addEventListener("beforeunload", function (event) { event.preventDefault(); event.returnValue = ""; });
    </script>`;
  return document("Playing Card", body, state.signedIn).replace(
    "<body>",
    `<body data-path="${path}">`,
  );
}

function textEditorPage(state: FixtureState, project: FixtureProject, face: FixtureFace): string {
  const from = face === "front" ? "text_front" : "text_back";
  const body = `
    <h2>Add Text To ${face === "front" ? "Front" : "Back"}</h2>
    <a href="javascript:oDesign.setNextStep();">Next</a>
    <script>
      var oDesign = {
        setNextStep: function () {
          fetch("/fixture/next?ssid=${project.ssid}&from=${from}").then(function (r) { return r.text(); }).then(function (url) { window.location.href = url; });
        },
      };
    </script>`;
  return document("Design Text", body, state.signedIn);
}

function previewPage(state: FixtureState, project: FixtureProject): string {
  const body = `
    <h2>Preview &amp; Add to Cart</h2>
    <div>Front (1) Back (1)</div>
    <p>Please review your design carefully before finalizing your order.</p>
    <input id="btn_accept" type="checkbox"> I confirm that all the images are correct.
    <input id="btn_next_step" type="button" value="Add to cart" data-ssid="${project.ssid}">`;
  return document("Preview", body, state.signedIn);
}

function savedProjectsPage(state: FixtureState): string {
  const rows = [...state.projects.values()]
    .filter((project) => project.name !== null)
    .map(
      (project) =>
        `<tr><td class="name">${project.name}</td><td>Playing Card</td><td><a href="${FIXTURE_BASE_URL}/products/playingcard/design/dn_playingcards_front_dynamic.aspx?ssid=${project.ssid}">Continue to edit</a></td></tr>`,
    )
    .join("");
  return document(
    "Saved Projects",
    `<h2>Saved projects</h2><table id="saved"><tbody>${rows}</tbody></table>`,
    true,
  );
}

function signInPage(): string {
  const body = `
    <h2>Sign in</h2>
    <input id="txt_email" type="text"><input id="txt_password" type="password">
    <input id="ckb_remember" type="checkbox">
    <input id="btn_submit" type="button" value="Sign in">
    <script>
      document.getElementById("btn_submit").addEventListener("click", function () {
        fetch("/fixture/signin", { method: "POST" }).then(function () { window.location.href = "${FIXTURE_BASE_URL}/design/custom-blank-card.html"; });
      });
    </script>`;
  return document("MakePlayingCards.com Login", body, false);
}

const NEXT: Record<FixtureStage, string> = {
  front_designer: "/design/dn_texteditor_front.aspx",
  text_front: "/products/playingcard/design/dn_playingcards_back_dynamic.aspx",
  back_designer: "/design/dn_texteditor_back.aspx",
  text_back: "/design/dn_preview_layout.aspx",
  preview: "/design/dn_preview_layout.aspx",
};

export function fixturePid(bytes: Uint8Array): string {
  return createHash("sha1").update(bytes).digest("hex").toUpperCase();
}

/** Serve the stand-in site to `page`; returns the mutable server state. */
export async function installMpcFixture(
  page: Page,
  options: FixtureOptions = {},
): Promise<FixtureState> {
  const state: FixtureState = {
    signedIn: options.signedIn ?? true,
    projects: new Map((options.projects ?? []).map((project) => [project.ssid, project])),
    requests: [],
    drift: { ...(options.drift ?? {}) },
  };
  let nextSsid = 1;
  const html = (body: string) => ({ status: 200, contentType: "text/html; charset=utf-8", body });
  const redirect = (to: string) =>
    html(
      `<!doctype html><html><head><meta charset="utf-8"></head><body><script>location.replace(${JSON.stringify(to)})</script></body></html>`,
    );
  const project = (url: URL): FixtureProject => {
    const ssid = url.searchParams.get("ssid") ?? "";
    const found = state.projects.get(ssid);
    if (!found) throw new Error(`fixture: unknown ssid ${ssid}`);
    return found;
  };

  await page.route(`${FIXTURE_BASE_URL}/**`, async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    state.requests.push(`${request.method()} ${url.pathname}${url.search}`);
    try {
      switch (url.pathname) {
        case "/design/custom-blank-card.html":
          return route.fulfill(html(productPage(state)));
        case "/products/pro_item_process_flow.aspx": {
          const ssid = `FX${String(nextSsid++).padStart(30, "0")}`;
          state.projects.set(
            ssid,
            newFixtureProject(ssid, {
              stock: url.searchParams.get("stock") ?? "",
              size: url.searchParams.get("size") ?? "",
              effect: url.searchParams.get("effect") ?? "",
            }),
          );
          return route.fulfill(
            redirect(
              `${FIXTURE_BASE_URL}/products/playingcard/design/dn_playingcards_front_dynamic.aspx?ssid=${ssid}`,
            ),
          );
        }
        case "/products/playingcard/design/dn_playingcards_front_dynamic.aspx":
          return route.fulfill(html(designerPage(state, project(url), "front")));
        case "/products/playingcard/design/dn_playingcards_back_dynamic.aspx":
          return route.fulfill(html(designerPage(state, project(url), "back")));
        case "/products/playingcard/design/dn_playingcards_mode_nf.aspx":
          return route.fulfill(html(modePage(project(url), "front")));
        case "/products/playingcard/design/dn_playingcards_mode_nb.aspx":
          return route.fulfill(html(modePage(project(url), "back")));
        case "/design/dn_texteditor_front.aspx":
          return route.fulfill(html(textEditorPage(state, project(url), "front")));
        case "/design/dn_texteditor_back.aspx":
          return route.fulfill(html(textEditorPage(state, project(url), "back")));
        case "/design/dn_preview_layout.aspx":
          return route.fulfill(html(previewPage(state, project(url))));
        case "/design/dn_temporary_designes.aspx":
          return route.fulfill(
            state.signedIn
              ? html(savedProjectsPage(state))
              : redirect(`${FIXTURE_BASE_URL}/login.aspx?ru=saved`),
          );
        case "/login.aspx":
          return route.fulfill(html(signInPage()));
        case "/logout.aspx":
          state.signedIn = false;
          return route.fulfill(redirect(`${FIXTURE_BASE_URL}/design/custom-blank-card.html`));
        case "/fixture/signin":
          state.signedIn = true;
          return route.fulfill({ status: 200, body: "ok" });
        case "/fixture/mode": {
          const body = JSON.parse(request.postData() ?? "{}") as {
            ssid: string;
            face: FixtureFace;
            total: number;
            design: number;
          };
          const target = state.projects.get(body.ssid);
          if (!target) return route.fulfill({ status: 404, body: "no project" });
          target.quantity = body.total;
          target.modes[body.face] = body.design === 1 ? "same" : "different";
          target.slots[body.face] = new Array<string | null>(
            body.design === 1 ? 1 : body.total,
          ).fill(null);
          return route.fulfill({ status: 200, body: "ok" });
        }
        case "/fixture/upload": {
          const target = project(url);
          const face = url.searchParams.get("face") as FixtureFace;
          const bytes = request.postDataBuffer() ?? Buffer.alloc(0);
          const pid = fixturePid(bytes);
          if (!target.uploads[face].includes(pid)) target.uploads[face].push(pid);
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ pid }),
          });
        }
        case "/fixture/place": {
          const target = project(url);
          const face = url.searchParams.get("face") as FixtureFace;
          const slot = Number(url.searchParams.get("slot"));
          const pid = url.searchParams.get("pid") ?? "";
          if (!target.uploads[face].includes(pid) || slot < 0 || slot >= target.slots[face].length)
            return route.fulfill({ status: 400, body: "bad placement" });
          target.slots[face][slot] = pid;
          return route.fulfill({ status: 200, body: "ok" });
        }
        case "/fixture/save": {
          if (!state.signedIn) return route.fulfill({ status: 401, body: "sign in first" });
          const target = project(url);
          target.name = url.searchParams.get("name") ?? "";
          target.saves += 1;
          return route.fulfill({ status: 200, body: "ok" });
        }
        case "/fixture/next": {
          const target = project(url);
          const from = url.searchParams.get("from") as FixtureStage;
          return route.fulfill({
            status: 200,
            body: `${FIXTURE_BASE_URL}${NEXT[from]}?ssid=${target.ssid}`,
          });
        }
        default:
          return route.fulfill({ status: 404, body: `fixture: no page at ${url.pathname}` });
      }
    } catch (error) {
      return route.fulfill({
        status: 500,
        body: error instanceof Error ? error.message : String(error),
      });
    }
  });
  return state;
}
