describe('sample', () => {
    beforeAll(async () => {
        await page.goto(`${global.ST_URL}/st`);
        await page.waitForSelector('#send_textarea', { timeout: 60000 });
    });

    it('should render the SillyTavern title', async () => {
        await expect(page.title()).resolves.toMatch(/SillyTavern/i);
    });
});
