/* Boot and remote-control key routing. */
(function () {
    'use strict';

    var MEDIA_KEYS = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward', 'MediaRewind',
        'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue'];

    try {
        MEDIA_KEYS.forEach(function (k) { tizen.tvinputdevice.registerKey(k); });
    } catch (e) { /* not on a TV */ }

    var CODES = {
        37: 'left', 38: 'up', 39: 'right', 40: 'down', 13: 'enter',
        10009: 'back', 8: 'back', 27: 'back',
        10252: 'playpause', 415: 'play', 19: 'pause', 413: 'stop', 417: 'ff', 412: 'rewind',
        403: 'red', 404: 'green', 405: 'yellow', 406: 'blue',
        // keyboard equivalents for browser testing
        32: 'playpause', 89: 'yellow', 66: 'blue'
    };

    document.addEventListener('keydown', function (e) {
        var key = CODES[e.keyCode];
        if (!key) return;
        e.preventDefault();
        if (Player.active()) { Player.handleKey(key); return; }
        if (key === 'left' || key === 'right' || key === 'up' || key === 'down') UI.move(key);
        else if (key === 'enter') UI.select();
        else if (key === 'back' && !UI.back()) {
            try { tizen.application.getCurrentApplication().exit(); } catch (err) { /* browser */ }
        }
    });

    UI.start();
})();
