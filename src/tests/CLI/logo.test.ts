import chalk from 'chalk';

import {
  BUNDLE_DROP_LOGO_MONO,
  BUNDLE_DROP_LOGO_TRUECOLOR,
  buildBundleDropLogo,
} from '../../CLI/logo';

describe('buildBundleDropLogo', () => {
  const originalLevel = chalk.level;

  afterEach(() => {
    chalk.level = originalLevel;
  });

  it('renders the full-color logo on truecolor terminals', () => {
    chalk.level = 3;

    const logo = buildBundleDropLogo();

    expect(logo).toContain(BUNDLE_DROP_LOGO_TRUECOLOR);
    expect(logo).toContain(`${BUNDLE_DROP_LOGO_TRUECOLOR}\n\n`);
    expect(logo).toContain('React Native Bundle Drop CLI');
  });

  it('falls back to the cyan silhouette on non-truecolor terminals', () => {
    chalk.level = 1;

    const logo = buildBundleDropLogo();

    expect(logo).not.toContain(BUNDLE_DROP_LOGO_TRUECOLOR);
    // The mono silhouette uses full-block glyphs that the truecolor render never emits.
    expect(logo).toContain('\u2588');
    expect(logo).toContain('React Native Bundle Drop CLI');
  });

  it('keeps the mono silhouette to block glyphs and whitespace only', () => {
    expect(BUNDLE_DROP_LOGO_MONO).toMatch(/^[\s\u2580\u2584\u2588]+$/);
  });
});
