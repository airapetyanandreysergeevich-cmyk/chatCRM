# Сборочный образ для APK-обёртки. Собирается один раз и потом лежит в кэше
# докера: Android SDK весит под гигабайт, качать его при каждой сборке незачем.
FROM eclipse-temurin:17-jdk

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl unzip ca-certificates gnupg \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

ENV ANDROID_HOME=/opt/android-sdk
ENV PATH="${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${PATH}"

# Версии зафиксированы: «latest» в сборочном образе — это сборка, которая
# однажды сломается сама по себе, без единого изменения в проекте.
ARG CMDLINE_TOOLS=13114758
RUN mkdir -p "${ANDROID_HOME}/cmdline-tools" \
 && curl -fsSL -o /tmp/tools.zip \
      "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS}_latest.zip" \
 && unzip -q /tmp/tools.zip -d "${ANDROID_HOME}/cmdline-tools" \
 && mv "${ANDROID_HOME}/cmdline-tools/cmdline-tools" "${ANDROID_HOME}/cmdline-tools/latest" \
 && rm /tmp/tools.zip

RUN yes | sdkmanager --licenses > /dev/null \
 && sdkmanager --install "platform-tools" "platforms;android-35" "build-tools;35.0.0" > /dev/null

RUN npm install -g @bubblewrap/cli@1.25.0

# Бабблврап иначе полезет скачивать свои JDK и SDK — а они уже стоят.
RUN mkdir -p /root/.bubblewrap \
 && printf '{"jdkPath":"%s","androidSdkPath":"%s"}\n' "$JAVA_HOME" "$ANDROID_HOME" \
      > /root/.bubblewrap/config.json

WORKDIR /project
