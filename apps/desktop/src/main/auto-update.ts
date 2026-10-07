import { app, BrowserWindow, dialog, shell, type MessageBoxOptions } from 'electron';
import { autoUpdater, type UpdateInfo } from 'electron-updater';
import { L } from './menu-i18n.js';
import * as logger from './logger.js';

/**
 * Automatic updates (Dutch Toys Group).
 *
 * The feed is the public download page on dashboard-exit.com (the `publish`
 * block in electron-builder.yml): it serves latest.yml / latest-mac.yml and
 * redirects every installer, zip and blockmap to the private GitHub release.
 * electron-updater downloads only the blocks that changed, installs when the
 * app quits, and asks for a restart as soon as a download is ready.
 *
 * Off in dev builds, in the Windows portable build (it cannot replace
 * itself) and on Linux (no packages are published). Help → Check for Updates
 * then opens the download page instead.
 */
export const DOWNLOAD_PAGE_URL = 'https://dashboard-exit.com/crawler';

const FIRST_CHECK_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

let enabled = false;
let checking = false;
let downloadedVersion: string | null = null;
let promptedVersion: string | null = null;

export function autoUpdatesSupported(): boolean {
  if (!app.isPackaged) return false;
  if (process.platform === 'win32') return !process.env['PORTABLE_EXECUTABLE_DIR'];
  return process.platform === 'darwin';
}

function showBox(options: MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  return win && !win.isDestroyed() ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
}

export function initAutoUpdates(): void {
  enabled = autoUpdatesSupported();
  if (!enabled) {
    logger.log('info', 'main', 'Auto-update off (dev, portable or unsupported platform)');
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (m: unknown) => logger.log('info', 'main', `[updater] ${String(m)}`),
    warn: (m: unknown) => logger.log('warn', 'main', `[updater] ${String(m)}`),
    error: (m: unknown) => logger.log('error', 'main', `[updater] ${String(m)}`),
    debug: (m: string) => logger.log('debug', 'main', `[updater] ${m}`),
  };
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    downloadedVersion = info.version;
    void promptRestart(info.version);
  });
  // Errors also reach checkForUpdates()'s promise; this catches the ones
  // from background downloads. Never a dialog — a flaky network must not
  // interrupt someone mid-crawl.
  autoUpdater.on('error', (err: Error) => {
    logger.log('warn', 'main', `[updater] ${err.message}`);
  });
  setTimeout(() => void backgroundCheck(), FIRST_CHECK_DELAY_MS);
  setInterval(() => void backgroundCheck(), CHECK_INTERVAL_MS);
}

async function backgroundCheck(): Promise<void> {
  if (checking || downloadedVersion) return;
  checking = true;
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    logger.log('warn', 'main', `[updater] background check failed: ${(err as Error).message}`);
  } finally {
    checking = false;
  }
}

/** Once per downloaded version; "Later" leaves it to install on quit. */
async function promptRestart(version: string): Promise<void> {
  if (promptedVersion === version) return;
  promptedVersion = version;
  const labels = L();
  const r = await showBox({
    type: 'info',
    title: labels.dlgUpdateAvailableTitle,
    message: labels.msgUpdateReady.replace('{version}', version),
    detail: labels.detailUpdateReady,
    buttons: [labels.btnRestartNow, labels.btnLater],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (r.response === 0) autoUpdater.quitAndInstall();
}

/** Help → Check for Updates. */
export async function checkForUpdatesInteractive(): Promise<void> {
  if (!enabled) {
    await shell.openExternal(DOWNLOAD_PAGE_URL);
    return;
  }
  if (downloadedVersion) {
    promptedVersion = null;
    await promptRestart(downloadedVersion);
    return;
  }
  if (checking) return;
  checking = true;
  const labels = L();
  const installed = app.getVersion();
  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result || !result.isUpdateAvailable) {
      await showBox({
        type: 'info',
        title: labels.dlgUpToDateTitle,
        message: labels.msgUpToDate.replace('{version}', installed),
        buttons: [labels.btnOk],
        noLink: true,
      });
      return;
    }
    const latest = result.updateInfo.version;
    await showBox({
      type: 'info',
      title: labels.dlgUpdateAvailableTitle,
      message: labels.msgUpdateAvailable.replace('{version}', latest),
      detail:
        labels.detailInstalledLatest.replace('{installed}', installed).replace('{latest}', latest) +
        '\n\n' +
        labels.msgUpdateDownloading.replace('{version}', latest),
      buttons: [labels.btnOk],
      noLink: true,
    });
  } catch (err) {
    const r = await showBox({
      type: 'warning',
      title: labels.dlgUpdateCheckFailedTitle,
      message: labels.msgUpdateCheckFailed,
      detail: labels.detailUpdateCheckFailed
        .replace('{error}', (err as Error).message)
        .replace('{url}', DOWNLOAD_PAGE_URL),
      buttons: [labels.btnOpenDownloadPage, labels.btnClose],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (r.response === 0) void shell.openExternal(DOWNLOAD_PAGE_URL);
  } finally {
    checking = false;
  }
}
