# Instrukcje projektu

Przeczytaj też [`CLAUDE.md`](CLAUDE.md): zawiera architekturę, zasady prywatności, testowania i numerowania wersji. Poniższe zasady dotyczą przygotowania i publikacji gotowej wtyczki.

## Gotowa paczka dla odbiorców

- `dist/` to osobisty build. Może zawierać „O mnie” z lokalnych ustawień. Zostaje poza Gitem; nie dodawaj go do commitów ani GitHub Releases.
- `npm run build:release` buduje `.cache/release-build/`, nie czytając `local-config/defaults.json`. W dystrybucji `defaults.json` musi być dokładnie pustym obiektem `{}`.
- `npm run package` zawsze tworzy świeży build dystrybucyjny. Wyniki to `.cache/releases/vX.Y.Z/linkedin-comment-assistant-vX.Y.Z.zip` i `SHA256SUMS.txt`.
- Paczka ma tylko 11 plików wskazanych w `scripts/release.mjs`. Manifest jest w głównym katalogu ZIP-a. Dodatkowe pliki, dowiązania, brakujące zasoby, niepusty profil lub niezgodna wersja muszą zatrzymać pakowanie.
- Nie pakuj istniejącego `dist/`, całego repozytorium ani dowolnego katalogu roboczego. Nie dodawaj kluczy, lokalnych ustawień, kopii zapasowych, historii, logów i sond.
- Odbiorca rozpakowuje ZIP i ładuje stały folder przez „Załaduj rozpakowane” w trybie dewelopera. Aktualizacja podmienia pliki w tym samym folderze i wymaga przeładowania rozszerzenia oraz kart LinkedIna. „Source code (zip)” generowane przez GitHub wymaga builda.

## Przygotowanie wydania

1. Sprawdź stan Git i istniejące wydania. Nie nadpisuj opublikowanych tagów ani załączników. Repozytorium jest publiczne; nie zmieniaj jego widoczności w ramach wydania.
2. Zmień wersję raz na porcję pracy, przez `npm version patch|minor|major --no-git-tag-version`, zgodnie z `CLAUDE.md`. Zaktualizuj `CHANGELOG.md` po polsku. Same zmiany dokumentacji nie wymagają nowej wersji wtyczki.
3. Uzupełnij README: numer wersji, nazwę/link ZIP-a, instalację i istotne zmiany działania. Zachowaj fikcyjny przykład „O mnie”; nie zastępuj go prywatnym profilem.
4. Uruchom `npm ci`, `npm test` i `npm run test:release`. Ostatnie polecenie buduje ZIP, sprawdza SHA-256, ładuje rzeczywistą paczkę w świeżym profilu i uruchamia pełne E2E z atrapami API. Nie czyta prywatnego „O mnie” i nie wykonuje płatnych prób modelu.
5. Sprawdź archiwum również niezależnym czytnikiem ZIP. Potwierdź listę plików, pusty `defaults.json`, zgodność manifestu z `package.json` i sumę kontrolną. Nie poprawiaj ręcznie gotowego archiwum.
6. Przeskanuj lokalnie neutralny build i pliki przeznaczone do publikacji pod kątem sekretów. Nie wysyłaj ich do skanerów online. Nie skanuj całego katalogu roboczego ani prywatnego `local-config/` lub osobistego `dist/`. Historyczną obecność chronionych plików sprawdzaj przez metadane Git; nie odczytuj ich treści.

## Publikacja na GitHubie

Gdy zlecenie obejmuje publikację wydania, wykonaj cały proces bez ponownego pytania o tę samą zgodę:

1. Zapisz i wypchnij commit z numerem wersji, źródłami i dokumentacją. Do commita nie dodawaj ZIP-a, `.cache/`, `dist/` ani ustawień prywatnych.
2. Utwórz anotowany tag `vX.Y.Z` wskazujący dokładnie przetestowany commit i wypchnij go do `origin`. Nigdy nie przesuwaj istniejącego tagu ani nie używaj force push.
3. Przygotuj krótkie notatki wydania po polsku: zmiany, sposób instalacji ZIP-a, puste ustawienia i ograniczenia weryfikacji. Zapisz je w pliku tymczasowym; przy `gh` używaj `--notes-file`, aby zachować nowe linie.
4. Utwórz szkic przez `gh release create vX.Y.Z <ZIP> <SHA256SUMS.txt> --verify-tag --draft --title ... --notes-file ...`. Repozytorium to `auditlog/linkedin-comment-assistant`; publikacja nie zmienia jego widoczności.
5. Pobierz oba załączniki szkicu do nowego katalogu tymczasowego. Sprawdź SHA-256 pobranego ZIP-a względem lokalnie przetestowanego artefaktu i pobranego pliku sum. Zweryfikuj zawartość, wersję i tag/commit; samo istnienie załącznika nie wystarcza.
6. Dopiero po tych kontrolach opublikuj szkic przez `gh release edit vX.Y.Z --draft=false --latest`. Odczytaj wydanie ponownie i sprawdź, że zawiera właściwe załączniki i jest opublikowane.
7. W odpowiedzi podaj link do Release, krótką instrukcję instalacji, wynik testów i informację o commicie/pushu. Rozróżniaj atrapy LinkedIna/API od oceny prawdziwego modelu i bieżącego DOM LinkedIna.

Przy poprawce istniejącego wydania, gdy pliki się różnią, przygotuj nową wersję zamiast podmieniać binaria pod tym samym tagiem. Jeśli narzędzie lub uprawnienia blokują publikację, dokończ lokalne artefakty i testy oraz opisz konkretną blokadę.
