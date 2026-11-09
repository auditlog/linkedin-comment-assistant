# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Rozszerzenie Edge/Chrome (Manifest V3), które pomaga pisać komentarze na LinkedInie z Claude: post jest kontekstem, użytkownik pisze polecenie po polsku, model zwraca komentarz w języku posta. Opis dla użytkownika: `README.md`. Uzasadnienie decyzji: `docs/2026-11-09-design.md`. Historia: `CHANGELOG.md`.

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

- **Skrypt na stronie** (`src/content/`, bundel IIFE, tylko `www.linkedin.com`) **niczego nie dokłada do strony** (zasada „zero footprint” od 0.3.0, regulamin LinkedIna §8.2). Po fokusie w polu komentarza (z opóźnieniem 350 ms) czyta post (`linkedin-dom.js`) i wysyła `lca:bind`. Na żądanie panelu: `lca:insert` (wstawienie), `lca:expand` (kliknięcie „…więcej” i ponowny odczyt), `lca:getSelection`. Edytory pamięta w mapie token → `WeakRef`; po przerenderowaniu szuka pola po URN posta.
- **Service worker** (`src/background.js`) zapisuje `boundPost` w `chrome.storage.session`. Panel otwiera ikona lub `Alt+Shift+L` (`_execute_action` + `openPanelOnActionClick`).
- **Panel boczny** (`src/sidepanel/`, ESM z SDK) śledzi `boundPost` (tryb podążania). Gdy użytkownik ma pracę w toku (polecenie, komentarz, rozmowa), nie przełącza posta sam, tylko pokazuje pasek „Przełącz”. Automatyczna analiza startuje 600 ms po wyborze posta. Wszystkie wywołania API są w panelu, żeby klucze nie trafiały do kontekstu strony.

Model (`src/lib/`):
- `prompts.js` buduje stały prompt systemowy i bloki posta: `<post>` (z `author_headline`), `<shared_link>`, `<background>` (Harmonic), `<existing_comments>`, `<reply_to>`. Zadania: `analyze_post`, `write_comment`, `check_comment` (`quality.js`), `learn_voice` (`voice.js`).
- Prompt systemowy to lista bloków: stały (`buildSystemPrompt`) i, przy pisaniu komentarza, blok `<user_voice>` (`voice.js`: przykłady Twoich komentarzy i preferencje). Na API Anthropic każdy blok ma własny `cache_control`.
- Model odpowiada w znacznikach parsowanych przez `tagged.js` (także w trakcie strumienia); `quality.js` czyta `<issue type="…">`.
- Poprawka kontynuuje tę samą rozmowę: odpowiedź trafia do historii jako niezmienione `message.content`, historię tylko się dopisuje; po błędzie panel usuwa ostatnią wiadomość użytkownika.
- Po każdej wersji komentarza panel uruchamia w tle `check_comment`; heurystyki z `quality.js` działają też na ręczne zmiany.
- Historia komentarzy (`voice.js`) leży w `chrome.storage.local` pod kluczem `history` (do 100, jeden wpis na post). Po 3 nowych ręcznie poprawionych komentarzach panel wysyła `learn_voice` i zapisuje `settings.voiceNotes`.
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
- Czytaj tylko post, w którego polu użytkownik kliknął. Masowe czytanie strony (np. import starych komentarzy) to scraping zakazany w §8.2.
- Gdy odczyt posta przestaje działać, zacznij od list selektorów na górze `src/content/linkedin-dom.js`. Każdą poprawkę odwzoruj w `test/e2e/fixtures/feed.html` i w teście e2e.
- Testy e2e sprawdzają mechanikę na uproszczonej atrapie, nie na prawdziwym LinkedInie. Mów o tym wprost, gdy raportujesz wyniki.

**Claude API**
- Wywołania tylko przez `@anthropic-ai/sdk` (`src/lib/llm.js`). Jeden klient obsługuje Anthropic (`apiKey`) i OpenRouter (`authToken`, `baseURL: https://openrouter.ai/api`).
- SDK 1.x z API `2026-10-21` wysyła klucz Anthropic jako `Authorization: Bearer`. Tak ma być, nie zamieniaj tego na `x-api-key`.
- Nie wysyłaj parametru `thinking`: Opus 5.5 odrzuca próbę wyłączenia myślenia. Szybkością steruje `output_config.effort`.
- `fallbacks: "default"` z betą `server-side-fallback-2026-07-01` oraz `cache_control` na prompcie systemowym wysyłaj tylko do API Anthropic, nie do OpenRoutera.
- Gdy zmieniają się modele albo ceny, zaktualizuj `PROVIDERS` w `settings.js`, `PRICES` w `pricing.js` i README.

**Harmonic**
- Ścieżki API (`POST /companies`, `POST /persons`, `GET /companies/{urn}`) i nagłówek `apikey` pochodzą z dokumentacji firm trzecich, nie z oficjalnej (niedostępnej). Przy problemach zacznij od nagłówka `src/lib/harmonic.js`.
- Do modelu idą tylko publiczne fakty z `formatBackground`. Klucz Harmonic nie może trafić do promptu ani do `local-config/` (nie ma go w `LOCAL_DEFAULT_KEYS`). Listy i notatki zespołu nie są używane.

**Prompty i styl**
- `src/lib/style-rules.js` to skróty `miodkuj` (PL) i `humanizer` (EN), oba na licencji MIT. Zachowaj atrybucję w nagłówku pliku i w README.
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
- Tekst „O mnie” w `local-config/defaults.json` pochodzi z `/mnt/c/code/memory_pjz`. Nie przenoś danych z tamtego projektu do kodu i nie wysyłaj ich do jev ani innych usług zewnętrznych (tak stanowi `AGENTS.md` w `memory_pjz`).
