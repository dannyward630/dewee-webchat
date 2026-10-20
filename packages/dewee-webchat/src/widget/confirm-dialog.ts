// Built-in approval dialog for mutate/destructive page actions, rendered inside the widget panel.
// Accessible alertdialog: focus starts on "Deny", Tab stays inside, Escape denies. Agent-provided
// args are shown with textContent only.
import type { PageActionInfo } from "../actions/action-runner";
import type { Strings } from "./i18n";

let seq = 0;

export function showConfirmDialog(
  container: HTMLElement,
  s: Strings,
  action: PageActionInfo & { callId: string },
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<boolean> {
  const id = `dw-confirm-${++seq}`;
  const root = container.getRootNode() as ShadowRoot | Document;
  const previous = root.activeElement as HTMLElement | null;
  const backdrop = document.createElement("div");
  backdrop.className = "confirm-backdrop";
  backdrop.innerHTML = `
    <div class="confirm" role="alertdialog" aria-modal="true" aria-labelledby="${id}-t" aria-describedby="${id}-d">
      <h3 id="${id}-t"></h3>
      <div id="${id}-d" class="confirm-desc">
        <div class="confirm-action"><code></code><span class="sens"></span></div>
        <p class="confirm-text"></p>
        <p class="confirm-warn" hidden></p>
      </div>
      <pre class="confirm-args"></pre>
      <div class="confirm-buttons">
        <button type="button" class="btn deny"></button>
        <button type="button" class="btn allow"></button>
      </div>
    </div>`;
  const q = <T extends Element>(sel: string) => backdrop.querySelector(sel) as T;
  q<HTMLElement>("h3").textContent = s.confirmTitle;
  q<HTMLElement>("code").textContent = action.name;
  const sens = q<HTMLElement>(".sens");
  sens.textContent = action.sensitivity;
  sens.dataset.level = action.sensitivity;
  q<HTMLElement>(".confirm-text").textContent = action.description;
  if (action.sensitivity === "destructive") {
    const warn = q<HTMLElement>(".confirm-warn");
    warn.hidden = false;
    warn.textContent = s.confirmDestructive;
  }
  const argsText = JSON.stringify(args, null, 2);
  const pre = q<HTMLElement>(".confirm-args");
  if (argsText && argsText !== "{}") pre.textContent = argsText;
  else pre.remove();
  const deny = q<HTMLButtonElement>(".deny");
  const allow = q<HTMLButtonElement>(".allow");
  deny.textContent = s.deny;
  allow.textContent = s.allow;
  if (action.sensitivity === "destructive") allow.classList.add("danger");

  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      signal?.removeEventListener("abort", onAbort);
      backdrop.remove();
      previous?.focus?.();
      resolve(ok);
    };
    const onAbort = () => finish(false);
    if (signal?.aborted) return finish(false);
    signal?.addEventListener("abort", onAbort, { once: true });
    deny.addEventListener("click", () => finish(false));
    allow.addEventListener("click", () => finish(true));
    backdrop.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation(); // do not also close the chat panel
        finish(false);
      } else if (ev.key === "Tab") {
        ev.preventDefault();
        (root.activeElement === deny ? allow : deny).focus();
      }
    });
    container.appendChild(backdrop);
    deny.focus();
  });
}
