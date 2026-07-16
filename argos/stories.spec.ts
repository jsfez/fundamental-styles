import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from '@playwright/test';
import { argosScreenshot } from '@argos-ci/playwright';

type StoryIndex = {
    entries: Record<string, { id: string; title: string; name: string; type: string }>;
};

const indexPath = fileURLToPath(new URL('../storybook-chromatic/index.json', import.meta.url));
const index: StoryIndex = JSON.parse(readFileSync(indexPath, 'utf-8'));

const only = process.env.ARGOS_ONLY?.split(',').map((s) => s.trim());

// Loading indicators legitimately keep `aria-busy='true'` for as long as they
// are rendered, so waiting for it to clear never settles on their stories.
const LOADER = /load(ing|er)|skeleton|spinner|progress|busy/i;

const stories = Object.values(index.entries).filter(
    (entry) => entry.type === 'story' && (!only || only.includes(entry.id))
);

for (const story of stories) {
    test(`${story.title} › ${story.name}`, async ({ page }) => {
        await page.goto(`/iframe.html?id=${story.id}&viewMode=story`);
        // Wait for Storybook's own render cycle. Storybook 8+ exposes the active
        // renders on `__STORYBOOK_PREVIEW__.storyRenders`; match the one for this
        // story (fall back to the latest). Some stories render in a portal and
        // leave #storybook-root empty, so don't wait on the root itself.
        await page.waitForFunction((id) => {
            const renders =
                (
                    window as unknown as {
                        __STORYBOOK_PREVIEW__?: { storyRenders?: { id?: string; phase?: string }[] };
                    }
                ).__STORYBOOK_PREVIEW__?.storyRenders ?? [];
            const render = renders.find((r) => r.id === id) ?? renders[renders.length - 1];
            return render?.phase === 'completed' || render?.phase === 'finished';
        }, story.id);
        // Honour a story's own `chromatic: { disableSnapshot: true }` parameter, so
        // opting out of visual testing keeps working the same way.
        const disableSnapshot = await page.evaluate((id) => {
            const renders =
                (
                    window as unknown as {
                        __STORYBOOK_PREVIEW__?: {
                            storyRenders?: {
                                id?: string;
                                story?: { parameters?: { chromatic?: { disableSnapshot?: boolean } } };
                            }[];
                        };
                    }
                ).__STORYBOOK_PREVIEW__?.storyRenders ?? [];
            const render = renders.find((r) => r.id === id) ?? renders[renders.length - 1];
            return render?.story?.parameters?.chromatic?.disableSnapshot === true;
        }, story.id);
        test.skip(disableSnapshot, 'story opts out of snapshots (chromatic parameter)');
        // Scrollable containers (carousels, overflowing lists) may settle on a
        // non-deterministic offset: pin every scroll position before capturing.
        await page.evaluate(() => {
            for (const el of Array.from(document.querySelectorAll('*'))) {
                if (el.scrollLeft !== 0) el.scrollLeft = 0;
                if (el.scrollTop !== 0) el.scrollTop = 0;
            }
        });
        // SVG SMIL animations (`<animate>`, e.g. the Status Indicator gradients)
        // ignore `prefers-reduced-motion` and aren't covered by Argos's animation
        // stabilization, so a capture lands at an arbitrary point of the timeline.
        // Rewind them to their base state and pause: that's also where they settle
        // once finished, since SMIL defaults to `fill="remove"`.
        await page.evaluate(() => {
            for (const svg of Array.from(document.querySelectorAll('svg'))) {
                if (typeof svg.pauseAnimations !== 'function') continue;
                svg.setCurrentTime(0);
                svg.pauseAnimations();
            }
        });
        const isLoader = LOADER.test(story.title);
        await argosScreenshot(page, story.id, {
            stabilize: { waitForAriaBusy: !isLoader }
        });
    });
}
