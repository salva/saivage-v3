<script setup>
import { withBase } from 'vitepress';

const treatments = [
  { key: 'original', label: 'Original (light treatment)' },
  { key: 'dark-golden-blond', label: 'Golden blond, lighter peach face' },
  { key: 'dark-honey-hazel', label: 'Honey light brown / hazel' },
  { key: 'dark-ash-blue-grey', label: 'Ash light brown / blue-grey' },
  { key: 'dark-chestnut-green', label: 'Light chestnut / green' },
  { key: 'dark-sand-amber', label: 'Dark blond sand / amber' },
];
const logo = (key) => `saivage-${key}.svg`;
const badge = (key) => `made-with-saivage-${key}.svg`;
const asset = (filename) => withBase(`/brand/${filename}`);
const published = (filename) => `https://salva.github.io/saivage-v3/brand/${filename}`;
const markdown = (key) => `![Saivage](${published(logo(key))})\n\n![Made with Saivage](${published(badge(key))})`;
const html = (key) => `<img src="${published(logo(key))}" alt="Saivage" width="64" height="64" style="image-rendering: pixelated;">\n<img src="${published(badge(key))}" alt="Made with Saivage" width="210" height="44">`;
</script>

# Brand assets

Six pixel-art treatments, each with a matching **Made with Saivage** badge.
All are available equally: choose the treatment that suits your surface. The
light and dark samples below are independent of this site's theme.

The original SVG is preserved byte-for-byte. The five dark treatments preserve
the same 244 ordered artwork rectangles and use self-contained, region-aware
palette CSS. Each logo has a native 32×32 viewBox; each badge is 210×44 with
native-scale artwork. These are standalone SVG files, not a palette picker.

<div class="brand-gallery">
  <section v-for="t in treatments" :key="t.key" class="brand-treatment" :aria-labelledby="`brand-${t.key}`">
    <h2 :id="`brand-${t.key}`">{{ t.label }}</h2>
    <p class="brand-downloads">
      <a :href="asset(logo(t.key))" download>Download {{ t.label }} logo (SVG)</a>
      <a :href="asset(badge(t.key))" download>Download {{ t.label }} badge (SVG)</a>
    </p>
    <div v-for="surface in ['light', 'dark']" :key="surface" class="brand-sample" :class="`brand-sample-${surface}`" :data-surface="surface">
      <p>{{ surface === 'light' ? 'Light' : 'Dark' }} sample surface</p>
      <div class="brand-icons">
        <figure v-for="size in [32, 64, 128]" :key="size">
          <img :src="asset(logo(t.key))" :alt="`Saivage — ${t.label}, ${size} pixels, ${surface} surface`" :width="size" :height="size" :style="{ width: `${size}px`, height: `${size}px` }">
          <figcaption>{{ size }}×{{ size }}</figcaption>
        </figure>
      </div>
      <img class="brand-badge" :src="asset(badge(t.key))" :alt="`Made with Saivage — ${t.label}, ${surface} surface`" width="210" height="44">
    </div>
    <details class="brand-embed">
      <summary>Copy embedding examples — {{ t.label }}</summary>
      <p>Markdown</p>
      <pre><code>{{ markdown(t.key) }}</code></pre>
      <p>HTML (explicit integer dimensions)</p>
      <pre><code>{{ html(t.key) }}</code></pre>
    </details>
  </section>
</div>

## Use the files

The examples use absolute public Pages URLs. Copy the text from a treatment's
disclosure above. Use an external `<img>` rather than injecting inline SVG: this
keeps each SVG's IDs and palette styles isolated. No scripts, external fonts,
stylesheets or images are needed by the files themselves. Badge text uses system
fonts, not custom lettering, so its appearance can differ by platform.

For crisp icons, use integer multiples of 32 pixels (32, 64 or 128) and
`image-rendering: pixelated`. The SVG artwork also retains `crispEdges`.
Keep badges at their native 210×44 dimensions; do not squeeze either asset to a
fractional size. The previews wrap rather than shrink on narrow screens.

A built Saivage instance serves equivalent asset URLs at
`/docs/brand/<filename>` on that instance's origin. For downloaded files, use
the corresponding relative URL, for example `./saivage-original.svg` and
`./made-with-saivage-original.svg`, in place of the absolute URL. Keep the
dimensions and meaningful alt text from the HTML examples.

<style>
.brand-gallery .brand-treatment { margin-block: 2rem; }
.brand-downloads { display: flex; flex-wrap: wrap; gap: .5rem 1.5rem; }
.brand-sample { padding: 16px; margin-block: 12px; border: 1px solid #777; border-radius: 8px; }
.brand-sample-light { background: #f5f5f7; color: #20212a; }
.brand-sample-dark { background: #171820; color: #f5f5f7; }
.brand-icons { display: flex; flex-wrap: wrap; align-items: end; gap: 16px; margin-block: 16px; }
.brand-icons figure { margin: 0; flex: 0 0 auto; }
.brand-icons figcaption { font-size: 12px; line-height: 24px; }
.brand-gallery .brand-icons img { max-width: none; image-rendering: pixelated; }
.brand-gallery img.brand-badge { width: 210px; height: 44px; max-width: none; }
.brand-embed pre { overflow-x: auto; padding: 12px; background: var(--vp-code-block-bg); font-size: 12px; }
.brand-embed summary { cursor: pointer; }
</style>
