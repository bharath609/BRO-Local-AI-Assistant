const assert = require('node:assert/strict');
const test = require('node:test');
const { handleChat } = require('../src/assistant');

const emptyContext = { projects: [], settings: {}, user: { displayName: 'Bharath' } };
const youtubeContext = {
  lastTarget: { kind: 'site', url: 'https://www.youtube.com/watch?v=abcdefghijk' },
  mediaState: 'playing',
};

test('play, pause, and stop control the current video', async () => {
  const pause = await handleChat({ ...emptyContext, message: 'pause', context: youtubeContext });
  assert.equal(pause.actions[0].type, 'send_keys');
  assert.equal(pause.actions[0].args.keys, 'k');
  assert.equal(pause.context.mediaState, 'paused');

  const play = await handleChat({ ...emptyContext, message: 'play', context: { ...youtubeContext, mediaState: 'paused' } });
  assert.equal(play.actions[0].type, 'send_keys');
  assert.equal(play.context.mediaState, 'playing');

  const stop = await handleChat({ ...emptyContext, message: 'stop the video', context: youtubeContext });
  assert.equal(stop.actions[0].type, 'send_keys');
  assert.equal(stop.context.mediaState, 'stopped');

  const alreadyStopped = await handleChat({ ...emptyContext, message: 'stop', context: { ...youtubeContext, mediaState: 'stopped' } });
  assert.deepEqual(alreadyStopped.actions, []);
  assert.match(alreadyStopped.reply, /already stopped/i);
});

test('media keys are used outside a YouTube page', async () => {
  const result = await handleChat({
    ...emptyContext,
    message: 'volume up',
    context: { lastTarget: { kind: 'file', path: 'C:/Users/Bharath/Music/song.mp3', label: 'song.mp3' } },
  });
  assert.equal(result.actions[0].type, 'media_key');
  assert.equal(result.actions[0].args.key, 'volume_up');
});

test('risky commands wait for an explicit confirmation', async () => {
  const ask = await handleChat({ ...emptyContext, message: 'shut down the pc' });
  assert.deepEqual(ask.actions, []);
  assert.equal(ask.context.pending.action.type, 'system_power');

  const yes = await handleChat({ ...emptyContext, message: 'yes', context: ask.context });
  assert.equal(yes.actions[0].type, 'system_power');
  assert.equal(yes.actions[0].args.mode, 'shutdown');
  assert.equal(yes.context.pending, undefined);

  const cancel = await handleChat({ ...emptyContext, message: 'cancel', context: ask.context });
  assert.deepEqual(cancel.actions, []);
  assert.match(cancel.reply, /cancelled/i);
  assert.equal(cancel.context.pending, undefined);

  const replace = await handleChat({ ...emptyContext, message: 'open youtube', context: ask.context });
  assert.equal(replace.actions[0].type, 'open_url');
  assert.equal(replace.context.pending, undefined);
});

test('a stray yes never runs a stored action', async () => {
  const result = await handleChat({ ...emptyContext, message: 'yes' });
  assert.deepEqual(result.actions, []);
  assert.doesNotMatch(result.reply, /shut down|restart/i);
});

test('settings, folders, typing, and searches preserve the spoken values', async () => {
  const settings = await handleChat({ ...emptyContext, message: 'open bluetooth settings' });
  assert.equal(settings.actions[0].type, 'open_settings');
  assert.equal(settings.actions[0].args.uri, 'ms-settings:bluetooth');

  const folder = await handleChat({ ...emptyContext, message: 'create a new folder called Project Reports' });
  assert.equal(folder.actions[0].type, 'create_folder');
  assert.equal(folder.actions[0].args.name, 'Project Reports');

  const typing = await handleChat({ ...emptyContext, message: 'type Hello World' });
  assert.equal(typing.actions[0].type, 'type_text');
  assert.equal(typing.actions[0].args.text, 'Hello World');

  const gmail = await handleChat({ ...emptyContext, message: 'search my gmail for Invoices' });
  assert.equal(gmail.actions[0].type, 'open_url');
  assert.match(gmail.actions[0].args.url, /#search\/Invoices$/);

  const drive = await handleChat({ ...emptyContext, message: 'open google drive starred' });
  assert.equal(drive.actions[0].args.url, 'https://drive.google.com/drive/starred');
});

test('typing and clicking target the last opened window', async () => {
  const result = await handleChat({ ...emptyContext, message: 'click first result', context: youtubeContext });
  assert.equal(result.actions[0].type, 'click_first_result');
  assert.deepEqual(result.actions[0].args.target, { kind: 'site', url: youtubeContext.lastTarget.url, label: 'YouTube' });
});

test('forward and backward seek ten seconds by default on YouTube', async () => {
  const forward = await handleChat({ ...emptyContext, message: 'forward', context: youtubeContext });
  assert.equal(forward.actions[0].type, 'send_keys');
  assert.equal(forward.actions[0].args.keys, 'l');
  assert.match(forward.reply, /forward 10 seconds/i);

  const backward = await handleChat({ ...emptyContext, message: 'backward', context: youtubeContext });
  assert.equal(backward.actions[0].args.keys, 'j');
  assert.match(backward.reply, /10 seconds/i);

  const rewind = await handleChat({ ...emptyContext, message: 'rewind 30 seconds', context: youtubeContext });
  assert.equal(rewind.actions[0].args.keys, 'jjj');

  const ahead = await handleChat({ ...emptyContext, message: 'skip forward 20 seconds', context: youtubeContext });
  assert.equal(ahead.actions[0].args.keys, 'll');
});

test('next and previous video use the YouTube queue keys', async () => {
  for (const message of ['play the next video', 'next video', 'play next video']) {
    const result = await handleChat({ ...emptyContext, message, context: youtubeContext });
    assert.equal(result.actions[0].args.keys, '+n', message);
  }
  const previous = await handleChat({ ...emptyContext, message: 'play the previous video', context: youtubeContext });
  assert.equal(previous.actions[0].args.keys, '+p');
});

test('forward still navigates the browser when no video is playing', async () => {
  const context = { lastTarget: { kind: 'site', url: 'https://github.com/' } };
  const result = await handleChat({ ...emptyContext, message: 'forward', context });
  assert.equal(result.actions[0].type, 'send_keys');
  assert.equal(result.actions[0].args.keys, '%{RIGHT}');
});

test('scroll commands reach the open page with sensible amounts', async () => {
  const gmail = { lastTarget: { kind: 'site', url: 'https://mail.google.com/mail/u/0/' }, mediaState: '' };

  const down = await handleChat({ ...emptyContext, message: 'scroll down', context: gmail });
  assert.equal(down.actions[0].type, 'scroll');
  assert.equal(down.actions[0].args.direction, 'down');
  assert.equal(down.actions[0].args.amount, 5);
  assert.ok(down.actions[0].args.target, 'scroll is aimed at the opened page');

  const up = await handleChat({ ...emptyContext, message: 'scroll up a little', context: gmail });
  assert.equal(up.actions[0].args.direction, 'up');
  assert.equal(up.actions[0].args.amount, 2);

  const bare = await handleChat({ ...emptyContext, message: 'scroll', context: gmail });
  assert.equal(bare.actions[0].args.direction, 'down');

  const page = await handleChat({ ...emptyContext, message: 'page down', context: gmail });
  assert.equal(page.actions[0].args.amount, 8);

  const lot = await handleChat({ ...emptyContext, message: 'scroll down a lot', context: gmail });
  assert.equal(lot.actions[0].args.amount, 10);

  const times = await handleChat({ ...emptyContext, message: 'scroll down 2 times', context: gmail });
  assert.equal(times.actions[0].args.amount, 10);

  const inApp = await handleChat({ ...emptyContext, message: 'scroll down in youtube', context: youtubeContext });
  assert.equal(inApp.actions[0].args.direction, 'down');

  const more = await handleChat({ ...emptyContext, message: 'scroll more', context: gmail });
  assert.equal(more.actions[0].args.direction, 'down');
  assert.equal(more.actions[0].args.amount, 10);

  // Without a previous target BRO scrolls whichever window is in front.
  const noTarget = await handleChat({ ...emptyContext, message: 'scroll down', context: {} });
  assert.equal(noTarget.actions[0].type, 'scroll');
  assert.equal(noTarget.actions[0].args.target, undefined);

  const top = await handleChat({ ...emptyContext, message: 'scroll to the top', context: gmail });
  assert.equal(top.actions[0].type, 'send_keys');
  assert.equal(top.actions[0].args.keys, '^{HOME}');
});

test('local PC controls open Start, Task View, Run, and system tools', async () => {
  const start = await handleChat({ ...emptyContext, message: 'open start menu' });
  assert.equal(start.actions[0].type, 'windows_key');
  assert.equal(start.actions[0].args.keys, '');

  const taskView = await handleChat({ ...emptyContext, message: 'show task view' });
  assert.equal(taskView.actions[0].args.keys, 'tab');

  const quick = await handleChat({ ...emptyContext, message: 'open quick settings' });
  assert.equal(quick.actions[0].args.keys, 'a');

  const notifications = await handleChat({ ...emptyContext, message: 'show notifications' });
  assert.equal(notifications.actions[0].args.keys, 'n');

  const run = await handleChat({ ...emptyContext, message: 'open run dialog' });
  assert.equal(run.actions[0].args.keys, 'r');

  const clipboard = await handleChat({ ...emptyContext, message: 'show clipboard' });
  assert.equal(clipboard.actions[0].args.keys, 'v');

  const emoji = await handleChat({ ...emptyContext, message: 'open emoji picker' });
  assert.equal(emoji.actions[0].args.keys, '.');

  const taskManager = await handleChat({ ...emptyContext, message: 'open task manager' });
  assert.equal(taskManager.actions[0].type, 'open_desktop_target');
  assert.equal(taskManager.actions[0].args.target, 'task_manager');

  const controlPanel = await handleChat({ ...emptyContext, message: 'open control panel' });
  assert.equal(controlPanel.actions[0].type, 'open_desktop_target');
  assert.equal(controlPanel.actions[0].args.target, 'control_panel');

  const devices = await handleChat({ ...emptyContext, message: 'open device manager' });
  assert.equal(devices.actions[0].args.target, 'device_manager');

  const programs = await handleChat({ ...emptyContext, message: 'open programs and features' });
  assert.equal(programs.actions[0].args.target, 'programs_and_features');

  const recycle = await handleChat({ ...emptyContext, message: 'open recycle bin' });
  assert.equal(recycle.actions[0].args.target, 'recycle_bin');

  const taskbar = await handleChat({ ...emptyContext, message: 'open taskbar settings' });
  assert.equal(taskbar.actions[0].type, 'open_settings');
  assert.equal(taskbar.actions[0].args.uri, 'ms-settings:taskbar');
});

test('refresh works on the page, the foreground window, and the desktop', async () => {
  const page = await handleChat({ ...emptyContext, message: 'refresh the page', context: youtubeContext });
  assert.equal(page.actions[0].type, 'send_keys');
  assert.equal(page.actions[0].args.keys, '{F5}');
  assert.ok(page.actions[0].args.target);

  const plain = await handleChat({ ...emptyContext, message: 'refresh' });
  assert.equal(plain.actions[0].type, 'send_keys');
  assert.equal(plain.actions[0].args.keys, '{F5}');
  assert.equal(plain.actions[0].args.target, undefined);

  const desktop = await handleChat({ ...emptyContext, message: 'refresh the desktop' });
  assert.equal(desktop.actions[0].type, 'refresh_desktop');

  const switching = await handleChat({ ...emptyContext, message: 'switch window' });
  assert.equal(switching.actions[0].args.keys, '%{TAB}');
});

test('folders can be created with or without a name and location', async () => {
  const newFolder = await handleChat({ ...emptyContext, message: 'create a new folder' });
  assert.equal(newFolder.actions[0].type, 'create_folder');
  assert.equal(newFolder.actions[0].args.name, 'New folder');

  const short = await handleChat({ ...emptyContext, message: 'new folder called Reports' });
  assert.equal(short.actions[0].args.name, 'Reports');

  const located = await handleChat({ ...emptyContext, message: 'create a folder called Reports in downloads' });
  assert.equal(located.actions[0].args.name, 'Reports');
  assert.equal(located.actions[0].args.folder, 'Downloads');

  const noKeyword = await handleChat({ ...emptyContext, message: 'make a folder Project Notes' });
  assert.equal(noKeyword.actions[0].args.name, 'Project Notes');
});

test('values keep words that look like the wake word, and courtesies still strip', async () => {
  const folder = await handleChat({ ...emptyContext, message: 'create a folder called BRO Test Folder' });
  assert.equal(folder.actions[0].args.name, 'BRO Test Folder');

  const typed = await handleChat({ ...emptyContext, message: 'type BRO report' });
  assert.equal(typed.actions[0].args.text, 'BRO report');

  const polite = await handleChat({ ...emptyContext, message: 'open settings please' });
  assert.equal(polite.actions[0].type, 'open_desktop_target');

  const wake = await handleChat({ ...emptyContext, message: 'BRO open settings' });
  assert.equal(wake.actions[0].type, 'open_desktop_target');

  const tools = require('../src/tools');
  assert.equal(tools.resolveDesktopTarget('device manager').key, 'device_manager');
  assert.equal(tools.resolveDesktopTarget('services').command, 'services.msc');
  assert.equal(tools.resolveDesktopTarget('programs and features').key, 'programs_and_features');
});
