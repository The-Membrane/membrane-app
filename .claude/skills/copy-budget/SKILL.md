---
name: copy-budget
description: >-
  Hard word budgets for every piece of user-visible text in membrane-app. Load it BEFORE you write
  or change any UI text: a sheet, modal, card, row, button, label, heading, eyebrow, subtitle, empty
  state, error, footnote, landing section or chart caption. Also load it when the owner says "too many
  words", "too much copy", "too many subheadings", "this is ugly / disgusting / cluttered", or "cut the
  text". Sets the numbers (words per surface, one heading per block, no sub-lines under rows), says
  where explanations go instead (one Details disclosure), and requires a rendered word count in every
  screenshot report. Use it together with ui-design-audit (principle 5, Quiet) and branding-guidelines.
---

# Copy budget

**Owner ruling (2026-10-25):** surfaces carry too many words and too many subheadings. Numbers and
actions carry the page. Words are allowed only where a user would otherwise make a mistake.

This skill is for the moment you WRITE text. `ui-design-audit` §5 (Quiet) is the after-the-fact
check. When the two disagree, the tighter limit wins.

## The budgets

Count the words a user sees **before they open anything**. Numbers, units and addresses count as one
word each. Text behind a closed disclosure or a tooltip does not count.

| Surface | Visible words, max | Headings |
|---|---|---|
| Transaction sheet / modal / slip | 60 | Title only (≤ 4 words). No eyebrow above it, no subtitle under it |
| Card | 25 | One title. No subtitle |
| Table / list row | label ≤ 3 words + value | None |
| Section of a page | 40 of prose | One heading. Pick an eyebrow OR a heading, never both stacked |
| Button | ≤ 3 words, verb + object ("Migrate position") | — |
| Error / blocker | ≤ 12 words: what is wrong + what to do | — |
| Provenance stamp | ≤ 8 words, one per surface (`Anvil · block 68 · Membrane oracle`) | — |
| Landing hero | headline ≤ 12 words, subhead ≤ 20 words | One H1 |

## Rules

1. **Rows are label + value.** A row never gets a sub-line of explanation. If a value needs a unit,
   put the unit in the value (`76.5% max`), not in a sentence below it.
2. **One heading per block.** Never stack eyebrow + title + subtitle. Never write a subheading that
   restates the heading.
3. **Explanations go behind one `Details` disclosure per surface.** Do not use a disclosure per row.
   Closed by default. The surface must still be correct and safe with it closed.
4. **Steps are numbered verbs.** In a signing flow, each step is `01 Sign · aToken permit`, not a
   paragraph. What the permission allows goes in Details, as one line per step.
5. **State is shown, not written.** Use the design system for state: colour, a struck-through done
   step, a disabled button with a ≤ 6-word reason. Never a sentence saying what the UI already shows.
6. **Required honesty labels stay, at their shortest.**
   - Labels: `(simulator)`, `would have`, `modelled`, `Demo — not yours`, the forecast class labels.
   - The long explanation of each moves to Details. A required label is never a reason to add a
     paragraph.
7. **No reassurance copy.** Cut "Nothing is signed until you confirm", "read-only, no signature",
   "the transaction is simulated before you sign" and similar. The button and step list already say
   it. Keep one only if a user has actually been misled without it, and then it counts against the
   budget.
8. **No repeated fine print.** A caveat is stated once per page, not once per card.

## How to write a surface

1. **Numbers and actions first.** Write the version with only the numbers, the labels and the buttons.
2. **Add words one at a time.** For each line you add, answer: *what wrong action does this prevent?*
   No answer means cut it.
3. **Count and keep within budget.** If you are over, move text into Details or delete it. Never
   shrink the font to fit more words.

## Check it, and report it

Every screenshot run that shows a surface you changed reports its visible word count. Measure it in
the shooter on the rendered page:

```js
const words = await page.$eval(SELECTOR, el => el.innerText.split(/\s+/).filter(Boolean).length)
```

Run it with every disclosure closed. Put `surface · words / budget` in your final report. A surface
over budget is not done.

## Before / after (the migrate sheet, 2026-10-25)

**Before:** about 300 visible words.
- An eyebrow, a title and a provenance line.
- Six rows, each with a sentence under it.
- Four signing steps, each with a 30–50-word paragraph.
- A footer sentence and a disabled-button reason.

**After (target):** under 60 visible words.

```
Migrate position                              Anvil · block 68
Repay on Aave            12,000 USDC
Move to Membrane         10 WETH · $20,000
New LTV                  60.0%   (max 76.5%)
Borrow                   $12,002
Flash-loan fee           $0
Sign   01 aToken permit  02 USDC permit  03 Operator  04 Migrate
[ Details ]                         [ Close ]  [ Simulate · 4 prompts ]
```

Details holds the following:
- the flash-loan mechanics;
- what each permission allows and that it stays until revoked;
- the borrow-LTV margin;
- the simulation note.
