/**
 * The URLs of the site's served assets (ADR-0013): the stylesheet and the
 * client bundle are committed files in `web/static/`, served by the app's
 * static routes and cached by the browser. This module is the one place that
 * names those URLs — the shell references them and the routes serve them, so
 * renaming an asset updates one file.
 */
export const SITE_CSS_URL = '/site.css';
export const CLIENT_SCRIPT_URL = '/client.js';
