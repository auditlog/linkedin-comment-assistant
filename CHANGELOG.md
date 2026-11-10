# Historia zmian

## 0.6.0 (2026-11-10)

- Ton i Długość wybrane w panelu mają pierwszeństwo przed Twoim stylem. Wcześniej prompt kazał modelowi naśladować ton i długość Twoich dawnych komentarzy i wyuczonych preferencji, więc wybór np. „Dłuższy” albo „Ciepły” mógł zostać pominięty. Przykłady i preferencje nadal kształtują słownictwo i rytm.
- Zmiana tonu lub długości po napisaniu komentarza: panel podpowiada, żeby kliknąć „Popraw”, a poprawka (także z pustym polem i „Konkretniej”) przekazuje modelowi nowe ustawienia. Wcześniej działały dopiero przy następnym „Napisz komentarz”.
- Poprawki z przeglądu 0.5.0:
  - „Zamknij” albo ponowne tłumaczenie w trakcie odczytu zaznaczenia przerywa poprzednie; starsze tłumaczenie nie nadpisuje nowszego, więc „Kopiuj” kopiuje to, co widać;
  - klucz API poprawiony w ustawieniach działa od razu w kolejnej poprawce komentarza (effort, rozumowanie i model zostają z chwili napisania);
  - Alt+Shift+T przy panelach otwartych w kilku oknach tłumaczy w panelu okna, w którym naciśnięto skrót;
  - rozwijany tekst w historii jest dla czytników ekranu przyciskiem.
- Obsługa postów z dokumentem i ankietą przechodzi na wersję 0.7.0 (po wynikach sondy), wideo później.

## 0.5.0 (2026-11-10)

- Effort i rozumowanie w dwóch grupach ustawień: „Pisanie i poprawki” oraz „Analiza, tłumaczenia i kontrola”. Effort od „Niska” do „Maksymalna” albo „Domyślna modelu”. Rozumowanie „Automatyczne” albo „Wyłączone”: to drugie tylko dla Sonnet 5.5 przy effort do „Wysoka”, a formularz blokuje je w pozostałych przypadkach i mówi dlaczego. Ustawienia sprzed 0.5.0 przechodzą bez zmian (obie grupy dostają dotychczasowy effort).
- Ustawienia pisania obowiązują dla całego komentarza: poprawki i „Konkretniej” idą z ustawieniami z chwili napisania, a zmiana działa od następnego „Napisz komentarz”.
- Przy effort „Bardzo wysoka” i „Maksymalna” wtyczka pozwala na dłuższą odpowiedź i czeka do 5 minut. Komunikat o przekroczeniu czasu podaje właściwy limit.
- „Pokaż tok rozumowania”: zwinięte „Jak myślał model” pod tłumaczeniem posta i pod komentarzem, ze streszczeniem rozumowania (bez dodatkowych kosztów).
- Tłumaczenie zaznaczenia: przycisk **Tłumacz** w panelu i skrót Alt+Shift+T. Tekst obcy tłumaczy na polski, polski na angielski, z uwagami o idiomach i tonie. Działa także w okienku czatu. Najwyżej 10 000 znaków; przy dłuższym zaznaczeniu karta mówi, że przetłumaczono początek. Karta nie znika i tłumaczenie nie jest przerywane, gdy wybierzesz inny post.
- Tłumaczenie komentarzy innych osób w karcie „Kontekst” (przycisk **Przetłumacz komentarze**). Karta pokazuje te komentarze z autorem i początkiem treści.
- Widok **Historia**: wyszukiwanie bez polskich znaków, filtr komentarze/wiadomości, rozwijanie tekstu, kopiowanie, link do posta i usuwanie wpisu.
- Kopia zapasowa w ustawieniach: eksport do pliku JSON (klucze API tylko na życzenie) i import z podglądem zmian. Import zachowuje obecne klucze, gdy w pliku ich nie ma, i łączy historię.
- Sonda `scripts/diagnose-linkedin.js` ma tryb `post`: pod postem opisuje cały post razem z obrazami, wideo i napisami (same znaczniki, bez adresów i treści). Wyniki dla postów z dokumentem, wideo i ankietą posłużą do wersji 0.6.0.
- README: instrukcja przeniesienia wtyczki na inny komputer, skróty klawiszowe, nowe sekcje dla tłumaczenia, historii i kopii zapasowej.

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
