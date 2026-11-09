# Historia zmian

## 0.4.2 (2026-11-09)

- Poprawka: okienka czatu w głównym oknie LinkedIna (np. na `/feed`) są w osadzonym fragmencie strony (shadow DOM). Wtyczka nie widziała kliknięcia w ich pole wiadomości. Teraz rozpoznaje pole także tam i potrafi do niego wstawić tekst.
- Rozmówca w okienku czatu: gdy nagłówek okienka nie zostanie rozpoznany, imię i profil rozmówcy są brane z jego wiadomości, a nie z pierwszego linku w okienku (który może prowadzić do Twojego profilu).

## 0.4.1 (2026-11-09)

- Poprawka: wiadomości na prawdziwym LinkedInie nie były odczytywane, bo czat działa w osobnej ramce strony (iframe). Skrypt wtyczki działa teraz także w ramkach LinkedIna, a wstawianie i rozwijanie trafia do ramki, z której przyszła rozmowa. Zaznaczony tekst można pobrać także z ramki.
- Skrypt diagnostyczny (`scripts/diagnose-linkedin.js`) sam wchodzi do ramki z kursorem i podaje jej adres bez parametrów oraz techniczne identyfikatory elementów (`data-testid`).

## 0.4.0 (2026-11-09)

- Wiadomości na LinkedInie: kliknięcie w pole wiadomości (pełna strona `/messaging/` albo okienko czatu) przełącza panel w tryb „Rozmowa”. Do modelu trafia 10 ostatnich wiadomości z oznaczeniem, które są Twoje.
- Osobny prompt dla prywatnych wiadomości: odpowiedź na ostatnią wiadomość rozmówcy, w jego języku, bez obietnic w Twoim imieniu i bez sztampowych zwrotów („I hope this message finds you well”).
- Kontrola jakości dla wiadomości: czy odpowiedź odnosi się do ostatniej wiadomości, czy nie składa zobowiązań, których nie było w poleceniu, i czy nie jest sztampowa.
- Wstawianie do pola wiadomości nic nie wysyła: kolejne linie są wstawiane jako miękkie złamania wiersza (jak Shift+Enter), bez zdarzeń klawisza Enter. Wiadomość wysyłasz przyciskiem LinkedIna.
- Twój styl osobno dla komentarzy i wiadomości (dwie listy preferencji w ustawieniach). Z rozmów zapisuje się tylko Twoja odpowiedź, bez treści i imienia rozmówcy.
- Harmonic działa też dla rozmówcy.

## 0.3.0 (2026-11-09)

- Bez ingerencji w wygląd LinkedIna: zniknął przycisk ✦ Asystent ze strony. Otwarty panel sam pobiera post, w którego polu komentarza klikniesz. „…więcej” wtyczka rozwija tylko na Twoje kliknięcie w panelu. Gdy masz pracę w toku, panel nie przełącza się sam, tylko proponuje przełączenie.
- Twój styl: wtyczka zapamiętuje komentarze, które wstawiasz lub kopiujesz (lokalnie, do 100). Ostatnie trafiają do promptu jako wzór. Z Twoich ręcznych poprawek uczy się listy preferencji, którą możesz edytować w ustawieniach.
- Kontrola jakości przed wstawieniem: natychmiastowe wykrywanie ogólników i wzorców AI oraz ocena modelu (czy komentarz tylko powtarza post, czy pasuje pod każdy post, czy dopisuje fakty). Przycisk „Konkretniej” poprawia komentarz według znalezionych problemów.
- Bogatszy kontekst: opis autora, podlinkowany artykuł i do 3 komentarzy innych osób (model nie powtarza ich myśli).
- Opcjonalnie Harmonic: etap, finansowanie, zespół i inwestorzy firmy autora oraz jego rola. Do modelu trafiają tylko publiczne fakty. Nowe uprawnienie: `https://api.harmonic.ai/*`.
- Poprawki: ukryte elementy panelu (np. „Uwzględnij grafikę” przy poście bez grafiki) naprawdę się ukrywają. Polskie frazy z ogonkami są wykrywane w kontroli jakości.

## 0.2.0 (2026-11-09)

- Reguły stylu w prompcie: angielskie na podstawie `humanizer` (komentarze po angielsku) i polskie na podstawie `miodkuj` (komentarze po polsku, tłumaczenia, pomysły, uwagi). Tłumaczenie zwrotne zostaje dosłowne.
- Domyślne „O mnie” z prywatnego pliku `local-config/defaults.json` (poza Gitem): wpisywane raz, tylko w puste pole, bez kluczy API.
- Cache promptu systemowego przy API Anthropic: kolejne zapytania w ciągu 5 minut są tańsze. Szacunek kosztu uwzględnia ceny odczytu z cache.
- Panel: wyraźniejsza hierarchia nagłówków, cytat posta bez bocznej kreski.
- Numer wersji: jedno źródło (`package.json`), `npm version` aktualizuje też manifest, a build zatrzymuje się przy niezgodności.

## 0.1.0 (2026-11-09)

- Pierwsza wersja: panel boczny przypięty do posta, przycisk ✦ Asystent przy polu komentarza, tłumaczenie posta i pomysły, komentarz z tłumaczeniem zwrotnym i uwagami, poprawki, wstawianie pod właściwy post.
- Dostawcy: API Anthropic albo OpenRouter, modele Sonnet 5.5 / Opus 5.5.
