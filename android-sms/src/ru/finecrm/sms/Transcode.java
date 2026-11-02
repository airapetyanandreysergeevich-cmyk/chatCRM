package ru.finecrm.sms;

import android.content.Context;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import android.net.Uri;

import java.io.File;
import java.nio.ByteBuffer;

/**
 * AMR и 3GP → m4a (1.5, 02.11.2026).
 *
 * Звонилки Honor, Huawei и части Xiaomi пишут разговор в AMR — его не играет ни
 * один браузер, ни на телефоне, ни на компьютере. Перегоняем здесь, встроенными
 * кодеками Android: распаковка (MediaCodec-декодер) → AAC (MediaCodec-кодер) →
 * контейнер MP4 (MediaMuxer). Без библиотек. Разговор на 5 минут — секунда-две.
 *
 * Не вышло (кодека нет, файл битый, дольше двух минут) — null: тогда уходит
 * исходный файл, и FineCRM предложит его скачать.
 */
final class Transcode {
    private Transcode() {}

    private static final String AAC = "audio/mp4a-latm";
    private static final long TIMEOUT_US = 10_000;
    private static final long GIVE_UP_MS = 2 * 60 * 1000;

    /** Нужно ли перегонять: всё, что браузер не играет. */
    static boolean needed(String mime) {
        return "audio/amr".equals(mime) || "audio/3gpp".equals(mime);
    }

    /** Готовый m4a во временной папке приложения или null. Файл удаляет вызвавший. */
    static File toM4a(Context c, Uri uri) {
        File out = new File(c.getCacheDir(), "call-" + System.currentTimeMillis() + ".m4a");
        boolean ok;
        try {
            ok = run(c, uri, out);
        } catch (Exception e) {
            ok = false;
        }
        if (!ok) {
            out.delete();
            return null;
        }
        return out;
    }

    private static boolean run(Context c, Uri uri, File out) throws Exception {
        MediaExtractor ex = new MediaExtractor();
        MediaCodec dec = null;
        MediaCodec enc = null;
        MediaMuxer mux = null;
        boolean muxStarted = false;
        boolean ok = false;
        try {
            ex.setDataSource(c, uri, null);
            int track = -1;
            MediaFormat inF = null;
            for (int i = 0; i < ex.getTrackCount(); i++) {
                MediaFormat f = ex.getTrackFormat(i);
                String m = f.getString(MediaFormat.KEY_MIME);
                if (m != null && m.startsWith("audio/")) {
                    track = i;
                    inF = f;
                    break;
                }
            }
            if (track < 0) return false;
            ex.selectTrack(track);
            int rate = inF.getInteger(MediaFormat.KEY_SAMPLE_RATE);
            int channels = inF.getInteger(MediaFormat.KEY_CHANNEL_COUNT);

            dec = MediaCodec.createDecoderByType(inF.getString(MediaFormat.KEY_MIME));
            dec.configure(inF, null, null, 0);
            dec.start();

            MediaFormat outF = MediaFormat.createAudioFormat(AAC, rate, channels);
            outF.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC);
            // Речь: 32 кбит/с на AMR 8 кГц с запасом, файл меньше исходного WAV в десятки раз.
            outF.setInteger(MediaFormat.KEY_BIT_RATE, rate <= 8000 ? 24000 : 48000);
            outF.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16384);
            enc = MediaCodec.createEncoderByType(AAC);
            enc.configure(outF, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            enc.start();

            mux = new MediaMuxer(out.getPath(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
            int muxTrack = -1;

            MediaCodec.BufferInfo dInfo = new MediaCodec.BufferInfo();
            MediaCodec.BufferInfo eInfo = new MediaCodec.BufferInfo();
            boolean exDone = false;
            boolean decDone = false;
            boolean encInDone = false;
            boolean encDone = false;
            // Распакованный звук, который ещё не влез в кодер.
            ByteBuffer pcm = null;
            long pcmBytes = 0;
            int bytesPerFrame = 2 * channels;
            long started = System.currentTimeMillis();

            while (!encDone) {
                if (System.currentTimeMillis() - started > GIVE_UP_MS) return false;

                // 1. Файл → декодер
                if (!exDone) {
                    int in = dec.dequeueInputBuffer(TIMEOUT_US);
                    if (in >= 0) {
                        ByteBuffer buf = dec.getInputBuffer(in);
                        int n = buf == null ? -1 : ex.readSampleData(buf, 0);
                        if (n < 0) {
                            dec.queueInputBuffer(in, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            exDone = true;
                        } else {
                            dec.queueInputBuffer(in, 0, n, ex.getSampleTime(), 0);
                            ex.advance();
                        }
                    }
                }

                // 2. Декодер → звук (pcm), если прежний кусок уже ушёл в кодер
                if (!decDone && pcm == null) {
                    int o = dec.dequeueOutputBuffer(dInfo, TIMEOUT_US);
                    if (o >= 0) {
                        ByteBuffer buf = dec.getOutputBuffer(o);
                        if (buf != null && dInfo.size > 0) {
                            ByteBuffer copy = ByteBuffer.allocate(dInfo.size);
                            buf.position(dInfo.offset);
                            buf.limit(dInfo.offset + dInfo.size);
                            copy.put(buf);
                            copy.flip();
                            pcm = copy;
                        }
                        if ((dInfo.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) decDone = true;
                        dec.releaseOutputBuffer(o, false);
                    }
                }

                // 3. Звук → кодер (кусками по размеру его буфера)
                if (!encInDone && (pcm != null || decDone)) {
                    int in = enc.dequeueInputBuffer(TIMEOUT_US);
                    if (in >= 0) {
                        ByteBuffer buf = enc.getInputBuffer(in);
                        long pts = pcmBytes / bytesPerFrame * 1_000_000L / rate;
                        if (pcm != null && buf != null) {
                            buf.clear();
                            int n = Math.min(buf.remaining(), pcm.remaining());
                            n -= n % bytesPerFrame;
                            if (n <= 0) n = Math.min(buf.remaining(), pcm.remaining());
                            ByteBuffer part = pcm.duplicate();
                            part.limit(part.position() + n);
                            buf.put(part);
                            pcm.position(pcm.position() + n);
                            pcmBytes += n;
                            enc.queueInputBuffer(in, 0, n, pts, 0);
                            if (!pcm.hasRemaining()) pcm = null;
                        } else {
                            enc.queueInputBuffer(in, 0, 0, pts, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            encInDone = true;
                        }
                    }
                }

                // 4. Кодер → файл
                int o = enc.dequeueOutputBuffer(eInfo, TIMEOUT_US);
                if (o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    muxTrack = mux.addTrack(enc.getOutputFormat());
                    mux.start();
                    muxStarted = true;
                } else if (o >= 0) {
                    ByteBuffer buf = enc.getOutputBuffer(o);
                    boolean config = (eInfo.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0;
                    if (buf != null && eInfo.size > 0 && !config && muxStarted) {
                        buf.position(eInfo.offset);
                        buf.limit(eInfo.offset + eInfo.size);
                        mux.writeSampleData(muxTrack, buf, eInfo);
                    }
                    if ((eInfo.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) encDone = true;
                    enc.releaseOutputBuffer(o, false);
                }
            }
            ok = muxStarted;
        } finally {
            try {
                if (dec != null) {
                    dec.stop();
                    dec.release();
                }
            } catch (Exception ignored) {
                // кодек уже закрыт
            }
            try {
                if (enc != null) {
                    enc.stop();
                    enc.release();
                }
            } catch (Exception ignored) {
                // кодек уже закрыт
            }
            try {
                if (mux != null) {
                    if (muxStarted) mux.stop();
                    mux.release();
                }
            } catch (Exception ignored) {
                ok = false;
            }
            ex.release();
        }
        return ok && out.length() > 0;
    }
}
