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
            // External files have no container index; list them after the embedded ones.
            .sort(function (a, b) { return (a.index == null ? 1e6 : a.index) - (b.index == null ? 1e6 : b.index); });
    }

    // Plex mixes ISO 639-2 bibliographic and terminology codes; compare on one of them.
    var LANG_ALIAS = { deu: 'ger', fra: 'fre', zho: 'chi', nld: 'dut', ces: 'cze', ell: 'gre', fas: 'per', ron: 'rum', slk: 'slo', sqi: 'alb', hye: 'arm', eus: 'baq', mya: 'bur', kat: 'geo', isl: 'ice', mkd: 'mac', msa: 'may', cym: 'wel' };
    function sameLang(a, b) { return !!a && !!b && (LANG_ALIAS[a] || a) === (LANG_ALIAS[b] || b); }

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
        var preferred = settings.audioLang && audios.filter(function (s) { return sameLang(s.languageCode, settings.audioLang); })[0];
        var chosen = audios.filter(function (s) { return s.id === requestedId; })[0] ||
            preferred || audios.filter(function (s) { return s.selected; })[0] || audios[0];
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

    function isImageSub(s) { return /pgs|hdmv|vobsub|dvd_sub|dvb_sub/i.test(s.codec || ''); }

    /* Default subtitle for playback, from settings.subtitles ('off' | 'forced' | 'always') and settings.subLang.
     * Image subtitles (PGS/VobSub) are skipped: the TV only hands text subtitles to apps. */
    function chooseSubtitle(part, audio, settings) {
        var subs = streams(part, 3).filter(function (s) { return !isImageSub(s); });
        var mode = settings.subtitles || 'forced';
        if (!subs.length || mode === 'off') return null;
        var lang = settings.subLang || (audio && audio.languageCode);
        var inLang = function (s) { return !lang || sameLang(s.languageCode, lang); };
        if (mode === 'forced') {
            return subs.filter(function (s) { return s.forced && (!audio || sameLang(s.languageCode, audio.languageCode) || inLang(s)); })[0] || null;
        }
        return subs.filter(function (s) { return s.selected; })[0] ||
            subs.filter(function (s) { return inLang(s) && !s.forced && !s.hearingImpaired; })[0] ||
            subs.filter(inLang)[0] || null;
    }

    // Apple TV-style badges for the details page.
    function badges(plan) {
        var out = [], m = plan.media || {}, v = plan.video, a = plan.audio;
        if (m.videoResolution === '4k' || (m.width || 0) >= 3800) out.push('4K');
        else if (/1080|720/.test(m.videoResolution || '')) out.push('HD');
        if (v) {
            var h = hdrLabel(v);
            if (/^HDR10\+/.test(h)) out.push('HDR10+');
            else if (v.DOVIPresent) out.push(v.DOVIProfile === 5 ? 'DV P5 · wrong colours' : 'HDR10 (DV base layer)');
            else if (/^HDR10/.test(h)) out.push('HDR10');
            else if (h === 'HLG') out.push('HLG');
        }
        if (a) {
            if (isAtmos(a)) out.push('Dolby Atmos');
            else if ((a.channels || 0) >= 8) out.push('7.1');
            else if ((a.channels || 0) >= 6) out.push('5.1');
        }
        if (streams(plan.part, 3).some(function (s) { return s.hearingImpaired; })) out.push('SDH');
        else if (streams(plan.part, 3).length) out.push('CC');
        return out;
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

    return {
        plan: plan, streams: streams, hdrLabel: hdrLabel, audioLabel: audioLabel, isTrueHd: isTrueHd, isAtmos: isAtmos,
        chooseSubtitle: chooseSubtitle, sameLang: sameLang, isImageSub: isImageSub, badges: badges
    };
})();
