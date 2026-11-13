// Failure: a password manager fills the visible input without a Vue input event, leaving connection permanently disabled.
async (page) => {
  await page.route('**/v1/state', async (route) => {
    if (route.request().headers().authorization !== 'Bearer autofill-test-owner') throw new Error('Autofilled owner was not submitted');
    await route.fulfill({ status: 403, json: { error: '浏览器回归：已读取自动填充密钥' } });
  });
  await page.route('**/v1/stream*', (route) => route.abort());
  await page.goto('http://127.0.0.1:5193');
  const input = page.getByRole('textbox', { name: '本人密钥', exact: true });
  await input.evaluate((element) => { element.value = 'autofill-test-owner'; });
  const submit = page.getByRole('button', { name: '连接中台', exact: true });
  if (await submit.isDisabled()) throw new Error('Visible autofilled credential leaves Connect disabled');
  await submit.click();
  await page.getByText('浏览器回归：已读取自动填充密钥', { exact: false }).waitFor();
  if (await input.inputValue() !== '') throw new Error('Submitted credential remains in the form');
  await page.unroute('**/v1/state');
  await page.unroute('**/v1/stream*');
  console.log('AUTOFILL_CONNECTION_PASSED');
}
