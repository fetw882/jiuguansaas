/* global window, document, MouseEvent */
jest.setTimeout(120000);

describe('advanced formatting system prompts', () => {
    const password = 'Passw0rd!';
    let email;

    beforeAll(async () => {
        email = `tester_${Date.now()}@example.com`;
        page.on('pageerror', () => {});
        await page.evaluateOnNewDocument(() => {
            window.getHordeModels = async () => [];
        });
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const url = request.url();
            if (url.includes('/api/horde/text-models') || url.includes('/api/horde/text-workers')) {
                request.respond({
                    status: 200,
                    contentType: 'application/json',
                    body: '[]',
                }).catch(() => {});
                return;
            }
            request.continue().catch(() => {});
        });
        await page.goto(`${global.ST_URL}/st-auth`, { waitUntil: 'networkidle0' });
        await page.click('#email', { clickCount: 3 });
        await page.type('#email', email);
        await page.click('#password', { clickCount: 3 });
        await page.type('#password', password);
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
            page.click('#btnSubmit'),
        ]);
        await page.waitForFunction(
            target => window.location.href.startsWith(target),
            { timeout: 60000 },
            `${global.ST_URL}/st`
        );
        await page.waitForSelector('#send_textarea', { timeout: 60000 });
        await page.evaluate(() => {
            if (typeof window.getHordeModels === 'function') {
                window.getHordeModels = async () => [];
            }
        });
    });

    it('loads default system prompts and applies one', async () => {
        await page.waitForSelector('#advanced-formatting-button .drawer-toggle', { timeout: 20000 });
        await page.evaluate(() => {
            const toggle = document.querySelector('#advanced-formatting-button .drawer-toggle');
            if (toggle) {
                toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            }
        });
        await page.waitForSelector('#AdvancedFormatting:not(.closedDrawer)', { timeout: 10000 });
        await page.waitForSelector('#SystemPromptBlock', { timeout: 10000 });
        await page.waitForFunction(() => document.querySelectorAll('#sysprompt_select option').length > 0, { timeout: 15000 });

        const options = await page.$$eval('#sysprompt_select option', opts => opts.map(o => o.textContent.trim()));
        expect(options.length).toBeGreaterThan(0);
        expect(options).toContain('Roleplay - Detailed');

        const targetValue = await page.$eval(
            '#sysprompt_select',
            (select, label) => {
                const found = Array.from(select.options).find(o => o.textContent.trim() === label);
                return found ? found.value : null;
            },
            'Roleplay - Detailed'
        );
        expect(targetValue).not.toBeNull();
        await page.select('#sysprompt_select', targetValue);
        await page.waitForFunction(() => {
            const el = document.querySelector('#sysprompt_content');
            return el && typeof el.value === 'string' && el.value.trim().length > 0;
        }, { timeout: 15000 });
        const content = await page.$eval('#sysprompt_content', el => el.value);
        expect(content).toMatch(/Develop the plot slowly/i);
    });
});
