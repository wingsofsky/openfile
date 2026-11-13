# Literary-Style Aesthetic Contract

The non-negotiable visual contract for Openfile. Every UI decision passes through this filter first.

## Product context

Openfile is a reader for long Chinese and English documents. The user spends hours inside a text surface, reading and reviewing. **Our job is to disappear.** The interface must *support the reader-writer posture* — quiet, attentive, book-like — not compete with the prose for attention.

Reference points: iA Writer, Medium (pre-2018), Substack writer surface, Are.na, Practical Typography (Butterick).

Anti-reference points: Notion (too system-y), Figma (too tool-y), Linear (too fast), every "AI productivity" SaaS dashboard.

## Type system

### Body copy (CJK + Latin mixed)

- Serif stack: `"Source Serif 4", "Noto Serif SC", "Source Han Serif SC", Georgia, serif`
- Base size: **18px desktop, 16px mobile**. Never below 16px for user-authored content.
- Line height: **1.65–1.80** — closer to 1.8 for CJK-dominant text, 1.65 for Latin-dominant UI prose.
- Max line length: **65–72 ch** (CSS `max-width: 72ch`). This is load-bearing, not a preference — it comes from Butterick's *Practical Typography* and every serious long-form publication observes it.

### UI chrome (buttons, labels, nav, tooltips)

- System stack: `ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`
- Size range: 14–16px. Never use decorative type here.
- Openfile chrome scale (based on Apple HIG / Fluent 2 / Material 3 / VS Code / Obsidian / Zed defaults): body and controls 13–15px (base 15px), captions and metadata never below 12px (12px only for short labels), section titles 14–16px; UI line-height ≈ 1.25–1.4. Reading prose stays 18px / ≥1.5 (above).

### Forbidden type moves

- No display faces or stylized headline fonts.
- No variable-weight animation (`font-variation-settings` transitions).
- No `font-weight: 900` — stop at 700.
- No letter-spacing tricks beyond ±0.01em, and only on small caps.

## Color palette

Near-monochrome. Total working palette ≤ 3 base tones + 2 optional accents.

| Role | Hex (light) | Hex (dark) |
|------|-------------|----------------------|
| Primary text | `#111111` | `#f5f5f5` |
| Secondary text, muted chrome | `#666666` | `#999999` |
| Hairlines, subtle panels | `#eeeeee` | `#2a2a2a` |
| Page background | `#fafafa` | `#1a1a1a` |

Optional accents (use *only* for semantic roles, never decoration):

- Warm: editorial red `#b33a3a` or ochre `#b8873a` — for errors, required markers, emphasis.
- Cool: ink blue `#2a4a6b` — for links, selected states.

### Banned colors / treatments

- **All gradients** (background, text, border, shadow).
- Neon, fluorescent, heavily saturated purples / pinks / cyans.
- Tailwind's default `blue-500` / `indigo-500` on CTAs.
- Any more than 3 colors visible in a single screen region.

## Spacing & layout

- Base grid: 4px. All spacing values are multiples of 4 or 8.
- Prose column: `max-w-[72ch]` (72 characters). Nothing wider for user-readable content.
- Left / right rails only when functional — no decorative sidebars.
- Never use Tailwind's `container` class for body copy (defaults to ~1280px).
- **Whitespace is the material.** When in doubt, double the vertical rhythm before adding an element.

## Motion

- Duration: **≤ 250ms** for any transition. Prefer 150–200ms for micro-interactions.
- Easing: `ease-out` for entrances, `ease-in` for exits, `cubic-bezier(0.4, 0, 0.2, 1)` for transforms.
- **Always gate on `prefers-reduced-motion: reduce`** — when set, disable translate and scale entirely; keep only opacity fades, and even those at ≤100ms.

### Banned motion

- Auto-play scroll animations.
- Parallax.
- Hero zoom-on-enter.
- Staggered animations across more than 3 items.
- Any motion triggered purely by hover (except the single opacity/color state change on interactive elements).

## Decoration

- **Shadows**: at most one, very faint (e.g., `shadow-[0_1px_2px_rgba(0,0,0,0.04)]`). Stacked shadows for "depth" are forbidden.
- **Borders**: 1px solid `#eee` (or `#2a2a2a` in dark). No gradient borders. No dotted / dashed except in error states.
- **Rounded corners**: 2–4px on cards and inputs. Never `rounded-full` on anything containing text longer than one word (avatar-like elements are fine).
- **Icons**: 16–20px, stroke width 1.5px, outline style only. Heroicons outline or Phosphor regular — pick one per surface and stick to it.

## CTAs & buttons

- **Primary CTA**: solid `#111` background, white text, 4px radius, 12–16px vertical padding, no shadow, no gradient. Hover: shift to `#333`, no scale change.
- **Secondary**: 1px `#111` border, transparent background, `#111` text. Hover: fill to `#111` background + white text.
- **Ghost / text buttons are banned for primary actions** on long-form reading surfaces — users don't recognize them as clickable and miss the action.

## Focus, keyboard, accessibility

Not a "nice to have" — these are part of the contract:

- Every interactive element has a visible `:focus-visible` ring. Use a 2px outline in the ink-blue accent.
  - One exception: the document body in the Review view is a writing surface, not a control. Its focus is the text caret, so it draws no ring; the Review view must look like the Read view.
  - A selection that stays pending while focus moves to another control (the comment bar) is painted with the system `Highlight` colour, so you still see what you selected.
- Tab order follows visual reading order; never override with `tabindex` > 0.
- All `<button>` elements have real text or an `aria-label`. No icon-only buttons without one.
- Touch targets ≥ 44px on mobile breakpoints.

## Why these rules exist

Every dial above points at the same outcome: **the writer's prose is the loudest object on screen.** Our chrome whispers.

When a future contributor is tempted to add a gradient for "visual interest", the answer is no — the interest comes from the writer's words, not our paint. When someone proposes a 400ms elastic hero animation "to make it feel premium", the answer is no — premium on a literary product means restraint, not theatrics.

The discipline isn't aesthetic austerity for its own sake. It's *the frame staying out of the painting's way*.
