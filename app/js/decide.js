/* Playback decision: can the TV direct-play this file, and what happens to the audio?
 *
 * Hard facts this encodes (Samsung 2022 Neo QLED, e.g. QN900B, Tizen 6.5):
 *  - HDR10 / HDR10+ / HLG in HEVC (and AV1/VP9) are decoded in hardware; HDR10+ dynamic metadata rides in the
 *    HEVC bitstream, so it survives as long as the video is NOT re-encoded (direct play, or direct stream copy).
 *  - Dolby Vision is not supported by any Samsung TV. Profile 7/8 files play their HDR10 base layer.
 *    Profile 5 has no HDR10 base layer: it plays with wrong (green/purple) colours.
 *  - DTS (any flavour) cannot be decoded or passed through by 2018+ Samsung TVs.
 *  - Dolby TrueHD from an internal app is handed to the TV's audio pipeline; whether it leaves over eARC as
 *    bitstream is decided by the TV firmware, not the app. Many reports say it does not (you get silence, PCM,
 *    or a forced transcode). E-AC3 (incl. E-AC3 Atmos/JOC) and AC3 pass through reliably.
 */
var Decide = (function () {
    'use strict';

    var DIRECT_CONTAINERS = ['mkv', 'mp4', 'm4v', 'mov', 'ts', 'm2ts', 'mpegts', 'webm', 'avi'];
    var DIRECT_VIDEO = ['hevc', 'h265', 'h264', 'avc', 'av1', 'vp9', 'mpeg2video', 'mpeg4', 'vc1'];
    var SAFE_AUDIO = ['eac3', 'ac3', 'aac', 'mp3', 'mp2', 'flac', 'opus', 'vorbis', 'pcm', 'lpcm', 'alac'];

    function streams(part, type) {
        return ((part && part.Stream) || []).filter(function (s) { return s.streamType === type; })
            .sort(function (a, b) { return (a.index || 0) - (b.index || 0); });
    }

    function isAtmos(s) { return /atmos/i.test((s.extendedDisplayTitle || '') + ' ' + (s.displayTitle || '') + ' ' + (s.title || '')); }
    function isDts(s) { return /^dca|^dts/i.test(s.codec || ''); }
    function isTrueHd(s) { return /truehd|mlp/i.test(s.codec || ''); }

    function hdrLabel(v) {
        if (!v) return 'unknown';
        var t = (v.extendedDisplayTitle || '') + ' ' + (v.displayTitle || '');
        if (/HDR10\+/i.test(t)) return 'HDR10+';
        if (v.DOVIPresent) return 'Dolby Vision P' + (v.DOVIProfile || '?') + (v.DOVIBLCompatID ? ' (HDR10 base)' : '');
        if (v.colorTrc === 'smpte2084') return 'HDR10 (HDR10+ if the file carries it)';
        if (v.colorTrc === 'arib-std-b67') return 'HLG';
        return 'SDR';
    }

    function audioLabel(s) {
        if (!s) return 'none';
        return s.extendedDisplayTitle || s.displayTitle || (s.codec + ' ' + (s.channels || '') + 'ch');
    }

    /* Pick the audio stream to use, and how to deliver it.
     * settings.truehd: 'auto' | 'direct' | 'transcode'
     * Returns { stream, transcode, reason } */
    function chooseAudio(part, requestedId, settings) {
        var audios = streams(part, 2);
        if (!audios.length) return { stream: null, transcode: false, reason: '' };
        var chosen = audios.filter(function (s) { return s.id === requestedId; })[0] ||
            audios.filter(function (s) { return s.selected; })[0] || audios[0];
        var explicit = requestedId != null;

        function sameLangAlt(pred) {
            return audios.filter(function (s) { return s !== chosen && s.languageCode === chosen.languageCode && pred(s); })
                .sort(function (a, b) { return (isAtmos(b) - isAtmos(a)) || ((b.channels || 0) - (a.channels || 0)); })[0];
        }

        if (isDts(chosen)) {
            var altD = !explicit && sameLangAlt(function (s) { return SAFE_AUDIO.indexOf(s.codec) >= 0; });
            if (altD) return { stream: altD, transcode: false, reason: 'DTS is not supported by Samsung TVs; switched to ' + audioLabel(altD) + '.' };
            return { stream: chosen, transcode: true, reason: 'DTS is not supported by Samsung TVs; the server will convert audio to E-AC3 5.1.' };
        }

        if (isTrueHd(chosen)) {
            if (settings.truehd === 'transcode') {
                return { stream: chosen, transcode: true, reason: 'TrueHD set to convert: the server sends E-AC3 5.1 (Atmos height channels are lost).' };
            }
            if (settings.truehd === 'auto' && !explicit) {
                var altT = sameLangAlt(function (s) { return s.codec === 'eac3' || s.codec === 'ac3'; });
                if (altT) return { stream: altT, transcode: false, reason: 'Using ' + audioLabel(altT) + ' instead of TrueHD; it passes through to the soundbar reliably.' };
            }
            return { stream: chosen, transcode: false, reason: 'Sending TrueHD as-is. Whether it reaches the Q990C as Atmos is up to the TV firmware. If you hear nothing or the soundbar shows PCM, press Yellow.' };
        }

        if (SAFE_AUDIO.indexOf(chosen.codec) < 0) {
            return { stream: chosen, transcode: true, reason: 'Audio codec ' + chosen.codec + ' is not playable here; the server will convert it.' };
        }
        return { stream: chosen, transcode: false, reason: '' };
    }

    /* Full plan for one media version. */
    function plan(item, mediaIndex, audioId, settings) {
        var media = (item.Media || [])[mediaIndex || 0] || {};
        var part = (media.Part || [])[0];
        var video = streams(part, 1)[0];
        var warnings = [];
        var videoOk = true;

        if (DIRECT_CONTAINERS.indexOf((media.container || '').toLowerCase()) < 0) {
            warnings.push('Container ' + media.container + ' may not open on the TV.');
        }
        if (video && DIRECT_VIDEO.indexOf((video.codec || '').toLowerCase()) < 0) {
            videoOk = false;
            warnings.push('Video codec ' + video.codec + ' cannot be decoded by the TV.');
        }
        if (video && video.DOVIPresent) {
            if (video.DOVIProfile === 5) warnings.push('Dolby Vision profile 5 has no HDR10 layer; colours will be wrong on a Samsung TV. Use a different version of this film.');
            else warnings.push('Dolby Vision is not supported by Samsung; the TV plays the HDR10 base layer.');
        }

        var audio = chooseAudio(part, audioId, settings);
        return {
            media: media, part: part, video: video,
            audio: audio.stream, audioReason: audio.reason,
            mode: audio.transcode ? 'audio-transcode' : 'direct',
            videoOk: videoOk, warnings: warnings,
            hdr: hdrLabel(video)
        };
    }

    return { plan: plan, streams: streams, hdrLabel: hdrLabel, audioLabel: audioLabel, isTrueHd: isTrueHd };
})();
