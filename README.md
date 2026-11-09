# Asystent komentarzy LinkedIn

Rozszerzenie do Microsoft Edge (działa też w Chrome), które pomaga pisać komentarze na LinkedInie z pomocą Claude. Piszesz po polsku, a wtyczka:

1. **tłumaczy post na polski**, a długi streszcza, i opisuje, co widać na grafice;
2. **podsuwa 3 pomysły na komentarz**, dopasowane do posta, do Ciebie i do tego, co inni już napisali;
3. **zamienia Twoje polecenie albo szkic na gotowy komentarz** w języku posta, zwykle po angielsku, w Twoim stylu, razem z tłumaczeniem zwrotnym i uwagami językowymi;
4. **sprawdza komentarz przed wstawieniem**: ostrzega, gdy tylko powtarza post albo brzmi ogólnikowo;
5. **wstawia komentarz w pole pod właściwym postem**, nawet jeśli feed się w międzyczasie przewinął.

Komentarz zawsze publikujesz Ty, przyciskiem LinkedIna. Model to Claude Sonnet 5.5 albo Opus 5.5, przez API Anthropic albo przez OpenRouter.

Historia zmian: [`CHANGELOG.md`](CHANGELOG.md). Decyzje projektowe: [`docs/2026-11-09-design.md`](docs/2026-11-09-design.md).

## Wymagania

- Microsoft Edge albo Chrome w wersji 116 lub nowszej.
- Node.js 20 lub nowszy (do budowania i testów).
- Klucz API Anthropic albo OpenRouter.
- Opcjonalnie: klucz API Harmonic (plan z dostępem do API).

## Instalacja

Kod jest w prywatnym repozytorium [auditlog/linkedin-comment-assistant](https://github.com/auditlog/linkedin-comment-assistant). Na tym komputerze leży w `C:\code\linkedin_plugin` (w WSL: `/mnt/c/code/linkedin_plugin`).

1. Pobierz kod (na nowym komputerze) i zbuduj rozszerzenie:
   ```bash
   git clone git@github.com:auditlog/linkedin-comment-assistant.git
   cd linkedin-comment-assistant
   npm install
   npm run build
   ```
   Gotowa wtyczka trafia do folderu `dist/`.
2. W Edge otwórz `edge://extensions` i włącz **Tryb dewelopera** (przełącznik po lewej).
3. Kliknij **Załaduj rozpakowane** i wskaż folder `dist` w katalogu projektu, np. `C:\code\linkedin_plugin\dist`. Edge działa w Windows, więc projekt powinien leżeć na dysku Windows (w WSL: `/mnt/c/...`).
4. Przypnij ikonę do paska: ikona puzzla, a potem oko przy „Asystent komentarzy LinkedIn”.
5. Odśwież otwarte karty LinkedIna (F5).

## Pierwsze uruchomienie

Kliknij ikonę wtyczki. Panel boczny otworzy się na ustawieniach.

1. Wybierz dostawcę i wklej klucz API:

   | Dostawca | Skąd wziąć klucz | Postać klucza | Model domyślny |
   |---|---|---|---|
   | Anthropic | https://console.anthropic.com/settings/keys | `sk-ant-…` | `claude-sonnet-5-5` |
   | OpenRouter | https://openrouter.ai/keys | `sk-or-…` | `anthropic/claude-sonnet-5.5` |

2. Uzupełnij **O mnie**: kilka zdań o swojej roli i o tym, jak lubisz pisać.
3. Kliknij **Sprawdź połączenie**, a potem **Zapisz ustawienia**.

## Jak używać

1. Otwórz panel ikoną wtyczki albo skrótem **Alt+Shift+L** i zostaw go otwartego.
2. Na LinkedInie kliknij w pole komentarza pod postem, bez względu na to, czy ma podpis „Dodaj komentarz…”, czy np. „Złóż życzenia…”. Panel sam pobierze ten post, a po chwili pokaże jego tłumaczenie i pomysły. Gdy post jest skrócony („…więcej”), kliknij w panelu **Rozwiń pełny tekst**.
3. Kliknij pomysł albo wpisz polecenie po polsku, np. „pogratuluj wejścia do Holandii i zapytaj, czy obsługują też floty mieszane”. Możesz też wpisać szkic po polsku albo po angielsku do poprawy.
4. Kliknij **Napisz komentarz** (Ctrl+Enter). Przeczytaj tłumaczenie zwrotne i uwagi.
5. Jeśli coś nie pasuje, wpisz w polu **Popraw** np. „krócej” albo „bez pytania”. Tekst możesz też zmienić ręcznie. Model weźmie Twoje zmiany pod uwagę przy kolejnej poprawce.
6. Przeczytaj wynik kontroli jakości nad przyciskami. Jeśli komentarz tylko powtarza post albo brzmi ogólnikowo, kliknij **Konkretniej**.
7. Kliknij **Wstaw pod postem**, przeczytaj komentarz na LinkedInie i opublikuj go.

Przy odpowiedzi na komentarz kliknij w pole odpowiedzi. Asystent weźmie pod uwagę post i komentarz, na który odpowiadasz.

Gdy masz już w panelu polecenie albo komentarz, a klikniesz pole pod innym postem, panel nie przełączy się sam. Pokaże pasek z przyciskiem **Przełącz na ten post**.

Karta **Kontekst** w kroku 1 pokazuje, co jeszcze trafia do modelu: opis autora, podlinkowany artykuł, liczbę komentarzy innych osób i (opcjonalnie) dane z Harmonic.

Gdy wtyczka źle odczyta post (LinkedIn często zmienia budowę strony), rozwiń **Pełny tekst posta** i popraw treść. Możesz też zaznaczyć tekst posta myszką i kliknąć **Użyj zaznaczonego tekstu**.

## Ustawienia

| Ustawienie | Działanie |
|---|---|
| Dostawca, klucz, model | Sonnet 5.5 jest szybszy i tańszy, Opus 5.5 staranniejszy. Po wybraniu „Inny model…” wpiszesz dowolny identyfikator modelu. |
| Głębokość myślenia | „Niska” jest najszybsza i wystarcza do komentarzy. „Domyślna modelu” wybierz, jeśli dostawca odrzuca parametr `effort`. |
| O mnie | Model korzysta z tych informacji tylko wtedy, gdy pasują do posta, i nie dopisuje faktów spoza nich. |
| Język komentarza | Domyślnie język posta, do wyboru angielski albo polski. |
| Od razu tłumacz post | Po wybraniu posta od razu przychodzą tłumaczenie i pomysły. Po wyłączeniu robisz to przyciskiem. |
| Grafika z posta | Obraz trafia do modelu. Przydaje się, gdy na grafice są daty, miejsca albo nazwiska. |
| Twój styl | Wtyczka zapamiętuje lokalnie komentarze, które wstawiasz lub kopiujesz, i pokazuje modelowi ostatnie jako wzór. Po 3 komentarzach poprawionych ręcznie uczy się listy Twoich preferencji, którą możesz edytować. „Wyczyść historię” usuwa zapamiętane komentarze. |
| Harmonic | Po wpisaniu klucza API Harmonic panel pokazuje etap, finansowanie, wielkość zespołu i inwestorów firmy autora oraz jego rolę. |

Ton i długość komentarza wybierasz w panelu przy każdym komentarzu. Wtyczka zapamiętuje ostatni wybór.

### „O mnie” z pliku lokalnego

Żeby nie wklejać „O mnie” po każdej instalacji, wpisz je w `local-config/defaults.json` (wzór: `local-config/defaults.example.json`). Plik nie trafia do Gita, a `npm run build` kopiuje go do `dist/defaults.json`.

- Przy pierwszym otwarciu panelu wtyczka wpisuje tekst w puste pole „O mnie”. Tekstu, który już tam jest, ani innych ustawień nie zmienia.
- Dzieje się to raz w danym profilu przeglądarki. Jeśli wyczyścisz pole ręcznie, tekst nie wróci.
- Plik może zawierać tylko pola `aboutMe`, `provider`, `models`, `effort`, `commentLanguage`, `tone` i `length`. **Klucze API są pomijane** i nigdy nie trafiają do `dist/`.

### Kontrola jakości

Po każdej wersji komentarza panel sprawdza go na dwa sposoby:

- od razu, bez modelu: ogólniki („Great post!”, „Świetny post”), zwroty typowe dla AI, myślniki, hashtagi, emoji i komentarz złożony prawie wyłącznie ze słów posta;
- modelem: czy komentarz coś wnosi, czy pasuje pod dowolny post, czy dopisuje fakty o Tobie spoza Twojego polecenia i „O mnie” oraz czy ma błędy językowe.

Ostrzeżenie nie blokuje wstawienia. Po ręcznej zmianie tekstu kliknij **Sprawdź ponownie**.

### Harmonic

Harmonic jest opcjonalny. Włączasz go w ustawieniach i wpisujesz klucz API Harmonic (wymaga planu z dostępem do API). Wtyczka pyta Harmonic o firmę albo osobę po adresie profilu autora na LinkedInie. Do modelu trafiają tylko publiczne fakty, a prompt zabrania cytowania liczb i inwestorów, których nie ma w poście. Listy i notatki Twojego zespołu nie są używane.

Uwaga: wtyczka korzysta z API Harmonic w kształcie opisanym w dokumentacji integracji firm trzecich (`POST /companies`, `POST /persons`, nagłówek `apikey`). Oficjalnej dokumentacji nie dało się pobrać. Jeśli Harmonic zwróci błąd, panel pokaże go w karcie Kontekst.

### Styl językowy

Prompt zawiera dwa krótkie zestawy reguł stylu. Model stosuje ten, który pasuje do języka tekstu:

- **angielski**, dla komentarzy, na podstawie [humanizer](https://github.com/blader/humanizer): bez „Great post!”, „delve”, „game-changer”, kontrastów typu „It's not just X, it's Y” i zakończeń typu „Exciting times ahead”;
- **polski**, dla komentarzy po polsku, tłumaczeń, pomysłów i uwag, na podstawie [miodkuj](https://github.com/bartekpucek/miodkuj): bez „warto zauważyć”, „kluczowy”, „dokonać”, stylu rzeczownikowego i kalk z angielskiego.

Tłumaczenie zwrotne nie podlega polskim regułom. Ma wiernie oddawać angielski komentarz, nawet jeśli brzmi sztywno, bo dzięki niemu sprawdzasz, co publikujesz.

### Koszt

Według cennika Anthropic jeden komentarz razem z analizą posta i kontrolą jakości kosztuje ok. 2,7 centa na Sonnecie 5.5 i ok. 5,4 centa na Opusie 5.5 (szacunek bez grafiki i bez poprawek). Grafika, poprawki i nauka stylu podnoszą koszt. Przy API Anthropic stała część promptu trafia do pamięci podręcznej (cache), więc w kolejnych zapytaniach w ciągu 5 minut kosztuje ok. 1/10 ceny. Panel pokazuje szacowany koszt bieżącego posta. OpenRouter może doliczać prowizję.

## Prywatność i bezpieczeństwo

- Wtyczka **nigdy nie publikuje sama**, tylko wstawia tekst do pola. Regulamin LinkedIna zabrania automatyzacji.
- Wtyczka **niczego nie dokłada do strony LinkedIna** ani nie zmienia jej wyglądu (regulamin, §8.2). Strona się zmienia tylko wtedy, gdy klikniesz w panelu „Wstaw” albo „Rozwiń pełny tekst”.
- Czyta tylko post, w którego polu komentarza klikniesz, albo tekst, który zaznaczysz lub wkleisz. Nie przegląda feedu. Gdy panel jest zamknięty, odczytany post zostaje w pamięci przeglądarki i nic nie trafia do modelu.
- Treść posta trafia do modelu jako materiał do przeczytania, a prompt każe ignorować polecenia ukryte w poście. To ogranicza ryzyko, ale go nie wyklucza, dlatego zawsze czytasz komentarz przed publikacją.
- Panel pokazuje tekst z LinkedIna i od modelu jako zwykły tekst, nie jako HTML.
- Historia Twoich komentarzy (do 100) leży tylko w pamięci lokalnej wtyczki. Ostatnie komentarze idą do modelu jako wzór stylu.
- Klucz API leży w pamięci lokalnej wtyczki (`chrome.storage.local`) w tym profilu przeglądarki. Nie synchronizuje się z kontem Microsoft i trafia tylko do wybranego dostawcy. Nie jest szyfrowany, więc nie instaluj wtyczki w profilu, z którego korzystają inne osoby.

## Aktualizacja i wersje

Po zmianie kodu uruchom `npm run build`. Potem w `edge://extensions` kliknij **Załaduj ponownie** przy wtyczce i odśwież kartę LinkedIna.

Numer wersji ma postać `MAJOR.MINOR.PATCH` i jest widoczny w `edge://extensions`. Zmieniasz go jednym poleceniem, które aktualizuje `package.json` i `src/manifest.json`:

```bash
npm version patch --no-git-tag-version   # poprawka, np. naprawiony odczyt posta
npm version minor --no-git-tag-version   # nowa funkcja albo zmiana zachowania
```

Opcja `--no-git-tag-version` sprawia, że npm nie tworzy własnego commita ani tagu. Nowy numer, wpis w `CHANGELOG.md` i zmiany w kodzie trafiają do jednego commita. Build zatrzymuje się, gdy numery w `package.json` i manifeście się różnią.

## Rozwój

```
local-config/   prywatne ustawienia domyślne (poza Gitem)
src/
  background.js           otwiera panel, przechowuje wybrany post
  content/content.js      tryb podążania za klikniętym polem, wstawianie tekstu
  content/linkedin-dom.js odczyt posta ze strony LinkedIna
  sidepanel/              panel boczny
  lib/                    prompty, reguły stylu, Twój styl (voice), kontrola jakości (quality),
                          Harmonic, wywołania API, ustawienia, ceny
test/unit/      testy jednostkowe (node:test)
test/e2e/       test całości w Chromium z atrapą LinkedIna i API
scripts/        ikony, wersja, wyszukiwanie Chromium
```

Gdy LinkedIn zmieni budowę strony i wtyczka przestanie odczytywać posty, zacznij od list selektorów na górze `src/content/linkedin-dom.js`.

### Testy

```bash
npm test            # testy jednostkowe
npm run test:e2e    # build i test w Chromium, bez kosztów i bez klucza API
```

Test E2E ładuje wtyczkę w Chromium pobranym przez Playwright (`~/.cache/ms-playwright`) albo w przeglądarce ze zmiennej `CHROMIUM_PATH`. Jeśli w WSL brakuje bibliotek NSS, pobierz je bez uprawnień administratora:

```bash
mkdir -p .cache/chromium-libs/debs && cd .cache/chromium-libs/debs
apt-get download libnspr4 libnss3
for f in *.deb; do dpkg -x "$f" ../root; done
```

Zrzuty ekranu panelu do przeglądu: `LCA_SCREENSHOTS=/ścieżka/do/folderu npm run test:e2e`.

## Źródła i licencje

Reguły stylu w `src/lib/style-rules.js` to skróty dwóch projektów na licencji MIT:

- **miodkuj**: © 2026 Bartek Pucek, https://github.com/bartekpucek/miodkuj;
- **humanizer**: blader, https://github.com/blader/humanizer, oparty na [Wikipedia: Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing).
