// Helpers for the stylesheet suites. guild.css uses app.css's tokens and owns only a few of its own, and the suites that pin "no custom properties" ask for
// exactly those:
//   - the design framework tokens: the first :root block, under the heading "Design framework tokens" (border-field, the type scale, control heights,
//     the focus ring, the status roles ...);
//   - the attendance outcome colours (--gs-out-<outcome> and its -edge and -ink) and the Raids tones (--gs-tone-<tone> and its -bg / -edge);
//   - --mark, a row's class colour that the data table's phone card reads.
// ownTokenNames(css) lists every such name; stripOwnTokens(css) is the stylesheet without their declarations.
const FRAMEWORK_HEADING = 'Design framework tokens';
// The Planner's Forge tokens moved to planner-forge.css (shared with the public main branch); the suites pass both files joined, planner-forge.css first.
const PLANNER_HEADING = 'Forge tokens used by the Planner';

function tokenBlocks(css) {
  const blocks = [];
  for (const heading of [PLANNER_HEADING, FRAMEWORK_HEADING]) {
    const at = css.indexOf(heading);
    if (at < 0) continue;
    const open = css.indexOf(':root {', at);
    const close = css.indexOf('\n}', open);
    if (open >= 0 && close >= 0) blocks.push(css.slice(open, close + 2));
  }
  return blocks;
}

function frameworkBlock(css) {
  return tokenBlocks(css).join('\n');
}

function ownTokenNames(css) {
  const names = new Set(['--mark']);
  for (const m of frameworkBlock(css).matchAll(/(--[\w-]+)\s*:/g)) names.add(m[1]);
  for (const m of css.matchAll(/(--gs-out-[a-z_]+(?:-ink|-edge)?)\s*:/g)) names.add(m[1]);
  for (const m of css.matchAll(/(--gs-tone-[a-z]+(?:-bg|-edge)?)\s*:/g)) names.add(m[1]);
  return names;
}

function stripOwnTokens(css) {
  return tokenBlocks(css).reduce((out, block) => out.replace(block, ''), css)
    .replace(/--gs-out-[a-z_]+(-ink|-edge)?\s*:/g, '')
    .replace(/--gs-tone-[a-z]+(-bg|-edge)?\s*:/g, '')
    .replace(/--mark\s*:/g, '');
}

// Rules that set `color` where a .gs-class-* colour must be able to win (same specificity, later in the file, would beat it): the plain ones.
// Only :where(...) selectors (zero specificity) may set it.
function classColourOverrides(css) {
  const bad = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim();
    if (!/(^|[^-\w])color\s*:/.test(m[2].replace(/(background|border)-color/g, ''))) continue;
    for (const one of sel.split(',').map(x => x.trim())) {
      if (/:(hover|focus)/.test(one)) continue; // a state colour is meant to replace the class colour
      if (/\.gs-classbadge(?![\w-])|\.gs-char-sub(?![\w-])|\.gs-dtable-primary\s+a(?![\w-])/.test(one.replace(/:where\([^)]*\)/g, ''))) bad.push(one);
    }
  }
  return bad;
}

module.exports = { frameworkBlock, ownTokenNames, stripOwnTokens, classColourOverrides };
