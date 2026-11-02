/* Boot and remote-control key routing. */
(function () {
    'use strict';

    var MEDIA_KEYS = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward', 'MediaRewind',
        'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue', 'ChannelUp', 'ChannelDown', 'Info',
        '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

    try {
        MEDIA_KEYS.forEach(function (k) { tizen.tvinputdevice.registerKey(k); });
    } catch (e) { /* not on a TV */ }

    var CODES = {
        37: 'left', 38: 'up', 39: 'right', 40: 'down', 13: 'enter',
        10009: 'back', 8: 'back', 27: 'back',
        10252: 'playpause', 415: 'play', 19: 'pause', 413: 'stop', 417: 'ff', 412: 'rewind',
        403: 'red', 404: 'green', 405: 'yellow', 406: 'blue', 427: 'chup', 428: 'chdown', 457: 'info',
        // keyboard equivalents for browser testing
        48: 'd0', 49: 'd1', 50: 'd2', 51: 'd3', 52: 'd4', 53: 'd5', 54: 'd6', 55: 'd7', 56: 'd8', 57: 'd9',
        32: 'playpause', 89: 'yellow', 66: 'blue', 71: 'green', 82: 'red', 73: 'info', 33: 'chup', 34: 'chdown'
    };

    document.addEventListener('keydown', function (e) {
        var key = CODES[e.keyCode];
        if (!key) return;
        e.preventDefault();
        if (Player.active()) { Player.handleKey(key); return; }
        if (IPTVPlayer.active()) { IPTVPlayer.handleKey(key); return; }
        if (/^d\d$/.test(key)) return;
        if ((key === 'info' || key === 'green') && !UI.sheetOpen() && IPTVUI.options(UI.kit.focused())) return;
        if (key === 'left' || key === 'right' || key === 'up' || key === 'down') UI.move(key);
        else if (key === 'enter') UI.select();
        else if (key === 'back' && !UI.back()) {
            try { tizen.application.getCurrentApplication().exit(); } catch (err) { /* browser */ }
        }
    });

    IPTV.init().then(null, function () {});
    UI.start();
})();
