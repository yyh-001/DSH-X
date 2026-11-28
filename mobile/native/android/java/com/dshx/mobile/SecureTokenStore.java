package com.dshx.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * 使用 AndroidKeyStore（AES-256-GCM）对每台主机的设备 Bearer Token 加密后存放在私有 SharedPreferences，
 * 避免明文凭证落在应用私有目录中。
 */
final class SecureTokenStore {
    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "dshx_host_tokens_v1";
    private static final String PREFS_NAME = "dshx_secure_tokens";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final String ENVELOPE_PREFIX = "v1:";
    private static final int GCM_TAG_BITS = 128;

    private final SharedPreferences prefs;

    SecureTokenStore(Context context) {
        this.prefs = context.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    synchronized void saveToken(String hostId, String token) throws Exception {
        if (hostId == null || hostId.isEmpty() || token == null || token.isEmpty()) {
            return;
        }
        SecretKey key = getOrCreateKey();
        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        cipher.init(Cipher.ENCRYPT_MODE, key);
        byte[] iv = cipher.getIV();
        byte[] ciphertext = cipher.doFinal(token.getBytes(StandardCharsets.UTF_8));
        String encoded = ENVELOPE_PREFIX
            + Base64.encodeToString(iv, Base64.NO_WRAP)
            + ":"
            + Base64.encodeToString(ciphertext, Base64.NO_WRAP);
        prefs.edit().putString(prefKey(hostId), encoded).apply();
    }

    synchronized String getToken(String hostId) {
        if (hostId == null || hostId.isEmpty()) {
            return "";
        }
        String raw = prefs.getString(prefKey(hostId), null);
        if (raw == null || !raw.startsWith(ENVELOPE_PREFIX)) {
            return "";
        }
        String rest = raw.substring(ENVELOPE_PREFIX.length());
        int sep = rest.indexOf(':');
        if (sep <= 0) {
            return "";
        }
        try {
            byte[] iv = Base64.decode(rest.substring(0, sep), Base64.NO_WRAP);
            byte[] ciphertext = Base64.decode(rest.substring(sep + 1), Base64.NO_WRAP);
            SecretKey key = getOrCreateKey();
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_BITS, iv));
            byte[] plain = cipher.doFinal(ciphertext);
            return new String(plain, StandardCharsets.UTF_8);
        } catch (Exception ex) {
            return "";
        }
    }

    synchronized void deleteToken(String hostId) {
        if (hostId == null || hostId.isEmpty()) {
            return;
        }
        prefs.edit().remove(prefKey(hostId)).apply();
    }

    private static String prefKey(String hostId) {
        return "host_" + hostId;
    }

    private static SecretKey getOrCreateKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(ANDROID_KEYSTORE);
        keyStore.load(null);
        if (keyStore.containsAlias(KEY_ALIAS)) {
            KeyStore.Entry entry = keyStore.getEntry(KEY_ALIAS, null);
            if (entry instanceof KeyStore.SecretKeyEntry) {
                return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
            }
        }
        KeyGenerator keyGenerator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE);
        KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build();
        keyGenerator.init(spec);
        return keyGenerator.generateKey();
    }
}
