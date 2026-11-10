# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Rozszerzenie Edge/Chrome (Manifest V3), które pomaga pisać komentarze na LinkedInie z Claude: post jest kontekstem, użytkownik pisze polecenie po polsku, model zwraca komentarz w języku posta. Od 0.4.0 to samo dla prywatnych wiadomości (tryb „Rozmowa”). Opis dla użytkownika: `README.md`. Uzasadnienie decyzji: `docs/2026-11-09-design.md`. Historia: `CHANGELOG.md`.

## Polecenia

```bash
npm run build                 # dist/ = rozpakowana wtyczka; w Edge: C:\code\linkedin_plugin\dist
npm test                      # testy jednostkowe (node:test)
node --test --test-name-pattern="buildParams" test/unit/lib.test.js        # jeden test jednostkowy
npm run test:e2e              # build + Chromium z wtyczką, atrapa LinkedIna i API (bez kosztów)
npm run build && node --test --test-name-pattern="lightbox" test/e2e/extension.test.js   # jeden test e2e
LCA_SCREENSHOTS=<katalog> npm run test:e2e   # zrzuty panelu (400 px) do przeglądu UI
node scripts/make-icons.mjs   # ponowne wygenerowanie ikon w src/icons
npm version patch --no-git-tag-version       # numer wersji, zasady niżej
```

Repozytorium: prywatne `auditlog/linkedin-comment-assistant` na GitHubie, gałąź `main`.

Projekt nie ma lintera ani formattera. Skrypty i testy uruchamiające przeglądarkę biorą opcje z `chromiumLaunchOptions()` (`scripts/chromium.mjs`). Ta funkcja wskazuje Chromium pobrany wcześniej do `~/.cache/ms-playwright` albo podany w `CHROMIUM_PATH` i dokłada brakujące w WSL biblioteki NSS z `.cache/chromium-libs`. Samo `chromium.launch()` się nie uruchomi, bo Playwright 1.65 szuka nowszej wersji przeglądarki, a system nie ma bibliotek NSS.

## Architektura

Trzy części wtyczki wymieniają wiadomości `lca:*`:

- **Skrypt na stronie** (`src/content/`, bundel IIFE, `www.linkedin.com`, **we wszystkich ramkach**: `all_frames`, `match_about_blank`, `match_origin_as_fallback`, bo czat LinkedIna działa w iframe od 2026-11; okienka czatu na `/feed` są w otwartym shadow DOM `#interop-outlet`, dlatego cel zdarzenia bierze z `composedPath()[0]`, aktywny element z `shadowRoot.activeElement`, a wyszukiwanie pól idzie przez `deepQueryAll`) **niczego nie dokłada do strony** (zasada „zero footprint” od 0.3.0, regulamin LinkedIna §8.2). Po fokusie w polu komentarza (z opóźnieniem 350 ms) czyta post (`linkedin-dom.js`) i wysyła `lca:bind`. Pole wiadomości (`.msg-form`) obsługuje `linkedin-messaging.js`: wysyła rozmowę jako obiekt o tym samym kształcie co post, z `kind: 'message'`, kluczem `msg:…`, rozmówcą jako `author`/`authorProfile` i transkrypcją 10 ostatnich wiadomości w `text` (linie „Ja:” to użytkownik). Na żądanie panelu: `lca:insert` (wstawienie), `lca:expand` (kliknięcie „…więcej” i ponowny odczyt), `lca:getSelection` (`selectedText()`: `window.getSelection()`, a gdy puste, otwarte shadow roots). Edytory pamięta w mapie token → `WeakRef`; po przerenderowaniu szuka pola po URN posta.
- **Service worker** (`src/background.js`) zapisuje `boundPost` w `chrome.storage.session` razem z `frameId` ramki, z której przyszedł. Panel wysyła `lca:insert` i `lca:expand` tylko do tej ramki (`chrome.tabs.sendMessage(…, { frameId })`), bo skrypt działa w wielu ramkach i odpowiedź z niewłaściwej mogłaby wygrać. `lca:getSelection` trafia do wszystkich ramek: odpowiada ta z zaznaczeniem, a ramka główna z opóźnieniem zwraca pusty wynik. Panel otwiera ikona lub `Alt+Shift+L` (`_execute_action` + `openPanelOnActionClick`). Polecenie `translate-selection` (Alt+Shift+T) synchronicznie woła `sidePanel.open` (wymaga gestu użytkownika), a potem zapisuje `translateRequest` `{tabId, windowId, at}` w `chrome.storage.session`; panel z tego okna wykonuje prośbę młodszą niż 10 s przy starcie albo po zmianie i ją usuwa (panel z innego okna ją zostawia).
- **Panel boczny** (`src/sidepanel/`, ESM z SDK) śledzi `boundPost` (tryb podążania). Gdy użytkownik ma pracę w toku (polecenie, komentarz, rozmowa), nie przełącza posta sam, tylko pokazuje pasek „Przełącz”. Automatyczna analiza startuje 600 ms po wyborze posta. Wszystkie wywołania API są w panelu, żeby klucze nie trafiały do kontekstu strony. Widoki `main`/`settings`/`history` przełącza `showView`. Karta „Tłumaczenie zaznaczenia” ma własny kontroler (`state.translateController`, poza `state.controllers`), więc `setPost` → `abortAll` jej nie przerywa; tłumaczenie komentarzy (`state.controllers.translateComments`) dotyczy posta i jest przerywane.

Model (`src/lib/`):
- Rodzaj tekstu (`post.kind`: `comment` | `message`) wybiera zadania, etykiety panelu, kontrolę jakości i pamięć stylu. Brak `kind` oznacza komentarz (wpisy sprzed 0.4.0).
- `prompts.js` buduje stały prompt systemowy i bloki posta: `<post>` (z `author_headline`), `<shared_link>`, `<background>` (Harmonic), `<existing_comments>`, `<reply_to>`. Dla wiadomości blok `<conversation>`. Zadania: `analyze_post`/`analyze_conversation`, `write_comment`/`write_message`, `check_comment` (`quality.js`), `learn_voice` (`voice.js`), `translate_text` (zaznaczenie, do `MAX_SELECTION_CHARS` = 10 000 znaków; obce → polski, polski → angielski) i `translate_comments` (komentarze już odczytane z postem, `<item>` na komentarz). Obie odpowiedzi używają tych samych znaczników (`<comment>` to także odpowiedź w wiadomości).
- Prompt systemowy to lista bloków: stały (`buildSystemPrompt`) i, przy pisaniu komentarza, blok `<user_voice>` (`voice.js`: przykłady Twoich komentarzy i preferencje). Na API Anthropic każdy blok ma własny `cache_control`.
- Model odpowiada w znacznikach parsowanych przez `tagged.js` (także w trakcie strumienia); `quality.js` czyta `<issue type="…">`.
- Poprawka kontynuuje tę samą rozmowę: odpowiedź trafia do historii jako niezmienione `message.content`, historię tylko się dopisuje; po błędzie panel usuwa ostatnią wiadomość użytkownika.
- Po każdej wersji komentarza panel uruchamia w tle `check_comment`; heurystyki z `quality.js` działają też na ręczne zmiany.
- Historia (`voice.js`) leży w `chrome.storage.local` pod kluczem `history` (do 100, jeden wpis na post lub rozmowę, z polem `kind`). Przykłady i nauka są osobne dla komentarzy i wiadomości (`VOICE_FIELDS`: `voiceNotes`/`voiceLearnedAt` i `messageVoiceNotes`/`messageVoiceLearnedAt`). Wpis z rozmowy nie zawiera nic o rozmówcy.
- Dwie grupy ustawień modelu: `activeConfig(settings, 'write')` (`effort`, `thinking`) dla pisania, poprawek i „Konkretniej”, `activeConfig(settings, 'analysis')` (`analysisEffort`, `analysisThinking`) dla analizy, tłumaczeń, kontroli i nauki stylu. W panelu `config(purpose)` (domyślnie `analysis`). `writeComment` zamraża `state.writeConfig` na całą rozmowę o komentarzu (przy `between_tools` API nie pozwala zmienić effortu w trakcie rozmowy, a zmiana myślenia unieważnia cache); `sendConversation` używa jej przez `frozenWriteConfig()`, która bierze tylko klucz API z bieżących ustawień. Ustawienia sprzed 0.5.0: `mergeSettings` kopiuje `effort` do brakującego `analysisEffort`.
- `history.js`: wyszukiwanie w historii (`normalizeForSearch`, `filterHistory`), `postUrl` (link tylko dla URN posta), `removeEntry`. `backup.js`: plik `{format: 'lca-backup', version: 1, …}`, `parseBackup` sprawdza typy i nigdy nie rzuca wyjątku, `applyBackupSettings` nie kasuje kluczy pustymi wartościami z pliku, `mergeHistory` łączy po `postKey`.
- `harmonic.js` (opcjonalny) pyta Harmonic po adresie profilu autora i skraca odpowiedź do publicznych faktów; czekanie na nie jest ograniczone (3 s przy analizie, 8 s przy komentarzu).

Ustawienia leżą w `chrome.storage.local` pod kluczem `settings` (`settings.js`). Prywatne wartości domyślne przechodzą drogę: `local-config/defaults.json` (poza Gitem) → build (`sanitizeLocalDefaults`, bez kluczy API) → `dist/defaults.json` → panel (`applyLocalDefaults`, raz na profil, flaga `localDefaultsApplied`).

## Wersje

- Format `MAJOR.MINOR.PATCH`. Numer jest zapisany w `package.json`. Zmieniaj go tylko poleceniem `npm version patch|minor|major --no-git-tag-version`; opcja zostaje także w repozytorium Git, bo npm nie dodałby zmienionego manifestu do własnego commita. Nowy numer, wpis w `CHANGELOG.md` i zmiany kodu idą w jednym commicie. Skrypt `version` przepisuje go do `src/manifest.json`, a build przerywa się, gdy oba numery się różnią. Nie poprawiaj numeru ręcznie.
- **PATCH:** poprawka błędu, nowe selektory po zmianie strony LinkedIna, poprawka tekstu w interfejsie bez zmiany działania.
- **MINOR:** nowa funkcja albo ustawienie, zmiana promptów lub reguł stylu (zmienia treść komentarzy), zmiana domyślnego modelu, nowe uprawnienie w manifeście.
- **MAJOR:** zmiana, po której użytkownik musi coś zrobić, np. ustawienia przestają być zgodne. Do wersji 1.0.0, czyli pierwszej sprawdzonej na prawdziwym LinkedInie, takie zmiany podbijają MINOR.
- Chrome przyjmuje tylko 1–4 liczby oddzielone kropkami. Przyrostki w rodzaju `-beta` blokują instalację. Etykietę wersji wpisuje się w `version_name` manifestu.
- Każda zmiana, która trafia do `dist/`, oznacza nowy numer i wpis w `CHANGELOG.md` (po polsku, z datą, najnowsza wersja na górze). Same testy albo dokumentacja nie zmieniają numeru. Wersję podbijaj raz na porcję pracy oddawaną użytkownikowi, nie przy każdym buildzie.

## Zasady projektu

**LinkedIn**
- Wtyczka nie publikuje i nie klika przycisków LinkedIna. Jedyny wyjątek to „…więcej” w treści posta (`expandSeeMore`), i to tylko na kliknięcie w panelu. Nie dodawaj automatyzacji, bo zakazuje jej regulamin LinkedIna.
- Skrypt na stronie nie dokłada elementów, stylów ani atrybutów i nie zmienia wyglądu strony; zmienia ją tylko na wyraźne żądanie z panelu (wstawienie, rozwinięcie). Test e2e porównuje `document.body.outerHTML` przed i po odczycie posta. Nie deklaruj `web_accessible_resources` (LinkedIn wykrywa po nich rozszerzenia).
- Czytaj tylko post albo rozmowę, w której polu użytkownik kliknął (rozmowa: najwyżej `MAX_MESSAGES` = 10). Masowe czytanie strony (np. import starych komentarzy, przeglądanie skrzynki) to scraping zakazany w §8.2.
- Wiadomości nigdy nie są wysyłane. Do pól wiadomości wstawiaj tylko przez `insertIntoEditor(…, { lineBreaks: 'soft' })` (`insertLineBreak` między liniami). `execCommand` nie wywołuje zdarzeń klawiszy ani `beforeinput`, ale `insertParagraph` daje zdarzenie `input`, które czat LinkedIna może potraktować jak Enter. Strażnik w `test/e2e/fixtures/messaging.html` rejestruje Enter, `input` typu `insertParagraph` i wysłanie formularza.
- Gdy odczyt posta albo rozmowy przestaje działać, poproś użytkownika o wynik `scripts/diagnose-linkedin.js` (README, „Gdy wtyczka źle odczytuje stronę”): anonimowy szkielet strony, który sam wchodzi do ramki z kursorem. Potem popraw listy selektorów w `src/content/linkedin-dom.js` lub `linkedin-messaging.js`. Wyniki leżą w `.cache/` (poza Gitem). Każdą poprawkę odwzoruj w `test/e2e/fixtures/feed.html` i w teście e2e.
- Testy e2e sprawdzają mechanikę na uproszczonej atrapie, nie na prawdziwym LinkedInie. Mów o tym wprost, gdy raportujesz wyniki.

**Claude API**
- Wywołania tylko przez `@anthropic-ai/sdk` (`src/lib/llm.js`). Jeden klient obsługuje Anthropic (`apiKey`) i OpenRouter (`authToken`, `baseURL: https://openrouter.ai/api`).
- SDK 1.x z API `2026-10-21` wysyła klucz Anthropic jako `Authorization: Bearer`. Tak ma być, nie zamieniaj tego na `x-api-key`.
- Parametr `thinking` ustawia tylko `buildParams` na podstawie konfiguracji z `activeConfig`; nigdy nie składaj go ręcznie. `{type: "between_tools"}` (wyłączone myślenie) przyjmuje tylko Sonnet 5.5 przy effort `low`/`medium`/`high` (`canDisableThinking`, `MODEL_CAPS`); `activeConfig` zamienia niedozwolone „off” na `adaptive`. `display: "summarized"` tylko z `{type: "adaptive"}`. Nigdy `{type: "disabled"}` ani `budget_tokens` (400 na obecnych modelach). Przy `xhigh`/`max`: `max_tokens` 64 000 i czas oczekiwania 5 minut.
- `fallbacks: "default"` z betą `server-side-fallback-2026-07-01` oraz `cache_control` na prompcie systemowym wysyłaj tylko do API Anthropic, nie do OpenRoutera.
- Gdy zmieniają się modele albo ceny, zaktualizuj `PROVIDERS` w `settings.js`, `PRICES` w `pricing.js` i README.

**Harmonic**
- Ścieżki API (`POST /companies`, `POST /persons`, `GET /companies/{urn}`) i nagłówek `apikey` pochodzą z dokumentacji firm trzecich, nie z oficjalnej (niedostępnej). Przy problemach zacznij od nagłówka `src/lib/harmonic.js`.
- Do modelu idą tylko publiczne fakty z `formatBackground`. Klucz Harmonic nie może trafić do promptu ani do `local-config/` (nie ma go w `LOCAL_DEFAULT_KEYS`). Listy i notatki zespołu nie są używane.

**Prompty i styl**
- `src/lib/style-rules.js` to skróty `miodkuj` (PL) i `humanizer` (EN), oba na licencji MIT. Zachowaj atrybucję w nagłówku pliku i w README.
- Ton i Długość wybrane w panelu mają pierwszeństwo przed `<user_voice>` (przykłady i wyuczone preferencje kształtują słownictwo i rytm). Zmiana tonu lub długości po napisaniu idzie do modelu w kolejnej poprawce (`buildRefineMessage(…, changed)`, `state.writtenWith`).
- `<back_translation>` nie podlega polskim regułom stylu, bo ma być dosłowne. Model nie może dopisywać opinii ani faktów spoza polecenia użytkownika i „O mnie”.
- Prompt systemowy musi być identyczny przy tych samych ustawieniach (cache), więc nie wstawiaj do niego dat ani identyfikatorów.
- Te zasady sprawdzają testy w `test/unit/*.test.js`. Zmieniaj je razem z promptami.
- W wyrażeniach regularnych dla tekstu polskiego nie używaj `\b` ani `\w` (znają tylko ASCII: `/\bświetny/` nie złapie „Świetny”). Używaj granic `(?<![\p{L}\p{N}_])…(?![\p{L}\p{N}_])` z flagą `u`, jak w `quality.js`.

**Interfejs**
- Tekst z LinkedIna i od modelu wstawiaj wyłącznie przez `textContent`.
- Teksty interfejsu pisz po polsku i bez form rodzajowych w czasie przeszłym: „Skopiowano”, „Wstawiono”, a nie „Skopiowałeś”. Komunikat błędu mówi, co się stało i co zrobić.
- Zmiany interfejsu sprawdzaj na zrzutach z `LCA_SCREENSHOTS` (szerokość panelu 400 px).
- Do ukrywania używaj atrybutu `hidden`; reguła `[hidden] { display: none !important; }` w `sidepanel.css` jest celowa (bez niej `display: flex` komponentu wygrywa z `hidden`).

**Prywatność**
- `local-config/` i `dist/` są poza Gitem. Kluczy API nie zapisuj ani w `local-config/`, ani w `dist/`; build je pomija.
- Eksport kopii zapasowej domyślnie nie zawiera kluczy API (`buildBackup({includeKeys: false})`); klucze tylko po zaznaczeniu „Dołącz klucze API”.
- Tekst „O mnie” w `local-config/defaults.json` pochodzi z `/mnt/c/code/memory_pjz`. Nie przenoś danych z tamtego projektu do kodu i nie wysyłaj ich do jev ani innych usług zewnętrznych (tak stanowi `AGENTS.md` w `memory_pjz`).
