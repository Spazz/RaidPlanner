// Helpers for the stylesheet suites. guild.css uses app.css's tokens and owns only a few of its own, and the suites that pin "no custom properties" ask for
// exactly those:
//   - the design framework tokens: the first :root block, under the heading "Design framework tokens" (border-field, the type scale, control heights,
//     the focus ring, the status roles ...);
//   - the attendance outcome colours (--gs-out-<outcome> and its -ink) and the Raids tones (--gs-tone-<tone> and its -bg / -edge);
//   - --mark, a row's class colour that the data table's phone card reads.
// ownTokenNames(css) lists every such name; stripOwnTokens(css) is the stylesheet without their declarations.
const FRAMEWORK_HEADING = 'Design framework tokens';

function frameworkBlock(css) {
  const at = css.indexOf(FRAMEWORK_HEADING);
  if (at < 0) return '';
  const open = css.indexOf(':root {', at);
  const close = css.indexOf('\n}', open);
  return open < 0 || close < 0 ? '' : css.slice(open, close + 2);
}

function ownTokenNames(css) {
  const names = new Set(['--mark']);
  for (const m of frameworkBlock(css).matchAll(/(--[\w-]+)\s*:/g)) names.add(m[1]);
  for (const m of css.matchAll(/(--gs-out-[a-z_]+(?:-ink)?)\s*:/g)) names.add(m[1]);
  for (const m of css.matchAll(/(--gs-tone-[a-z]+(?:-bg|-edge)?)\s*:/g)) names.add(m[1]);
  return names;
}

function stripOwnTokens(css) {
  const block = frameworkBlock(css);
  return (block ? css.replace(block, '') : css)
    .replace(/--gs-out-[a-z_]+(-ink)?\s*:/g, '')
    .replace(/--gs-tone-[a-z]+(-bg|-edge)?\s*:/g, '')
    .replace(/--mark\s*:/g, '');
}

module.exports = { frameworkBlock, ownTokenNames, stripOwnTokens };
