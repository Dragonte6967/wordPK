import csv
import json
import os
import re
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FREQ = r'F:\Downloads\oed词频\frequency-alpha-oed.txt'
PARTS = os.path.join(ROOT, 'wtf_parts')
OUT = os.path.join(ROOT, 'wtf.data')
GOOGLE_CACHE = os.path.join(tempfile.gettempdir(), 'oed5000_google.json')
ECDICT = os.path.join(tempfile.gettempdir(), 'ecdict.csv')

CJK = re.compile(r'[\u4e00-\u9fff]')
LATIN = re.compile(r'[A-Za-z]')
VAGUE = re.compile(r'^(?:未知|生僻词?|古语词?|某词|某个词|单词|词语|名称|缩写|词头|无|不详|待查|不明确|泛指|表示.+|一种.+)$')


def clean_meaning(word, text):
    if not isinstance(text, str):
        return ''
    text = text.replace('\ufeff', '').replace('\r', ' ')
    # remove code fences or labels
    text = re.sub(r'^```.*?$', '', text, flags=re.M)
    text = re.sub(r'^\s*(?:meaning|释义)\s*[:：]\s*', '', text, flags=re.I)
    # split into senses
    senses = re.split(r'[；;，,、/|\\\n]+', text)
    out = []
    for sense in senses:
        sense = sense.strip()
        if not sense:
            continue
        # drop parenthetical English / digits
        sense = re.sub(r'[（(][^（）()]*[）)]', lambda m: '' if LATIN.search(m.group(0)) or re.search(r'\d', m.group(0)) else m.group(0), sense)
        sense = re.sub(r'[A-Za-z0-9]+', '', sense)
        sense = re.sub(r'[\[\]{}<>《》"“”\'‘’`~!@#$%^&*_+=:：;；,，.。?？!！…—\-]+', ' ', sense)
        sense = re.sub(r'\s+', '', sense).strip()
        if not sense or not CJK.search(sense):
            continue
        if len(sense) > 18:
            # keep a meaningful prefix, cut at punctuation if possible
            sense = sense[:18]
        if VAGUE.match(sense):
            continue
        if sense.lower() == word.lower() or word.lower() in sense.lower():
            continue
        if sense not in out:
            out.append(sense)
        if len(out) >= 2:
            break
    result = '；'.join(out)
    if len(result) > 32:
        result = result[:32].rstrip('；，, ')
    if not result or not CJK.search(result) or LATIN.search(result):
        return ''
    return result


def load_parts():
    found = {}
    if not os.path.isdir(PARTS):
        return found
    for name in sorted(os.listdir(PARTS)):
        if not name.endswith('.json'):
            continue
        path = os.path.join(PARTS, name)
        try:
            text = open(path, encoding='utf-8').read().strip()
        except Exception:
            continue
        if text.startswith('```'):
            text = re.sub(r'^```[a-zA-Z]*\s*', '', text)
            text = re.sub(r'\s*```$', '', text)
        try:
            data = json.loads(text)
        except Exception:
            m = re.search(r'\[[\s\S]*\]', text)
            if not m:
                print('part parse failed', name, file=sys.stderr)
                continue
            try:
                data = json.loads(m.group(0))
            except Exception:
                print('part parse failed', name, file=sys.stderr)
                continue
        if not isinstance(data, list):
            continue
        for item in data:
            if not isinstance(item, dict):
                continue
            w = str(item.get('word', '')).strip()
            m = str(item.get('meaning', '')).strip()
            if w:
                found[w.lower()] = m
    return found


def load_google():
    try:
        return {str(k).lower(): str(v) for k, v in json.load(open(GOOGLE_CACHE, encoding='utf-8')).items()}
    except Exception:
        return {}


def load_ecdict(targets):
    result = {}
    if not os.path.exists(ECDICT):
        return result
    try:
        with open(ECDICT, encoding='utf-8', newline='') as f:
            r = csv.reader(f)
            header = next(r)
            idx = {name: i for i, name in enumerate(header)}
            for row in r:
                if not row:
                    continue
                w = row[idx['word']].strip().lower()
                if w in targets and w not in result:
                    result[w] = (row[idx.get('translation', 0)] if 'translation' in idx else '', row[idx.get('pos', 0)] if 'pos' in idx else '')
    except Exception as e:
        print('ecdict read failed', e, file=sys.stderr)
    return result


def main():
    raw = open(FREQ, encoding='utf-8').read().splitlines()
    data = [x for x in raw[1:] if x.strip()]
    selected = data[-5000:][::-1]
    words = []
    for line in selected:
        parts = line.split(None, 2)
        if len(parts) >= 2:
            words.append(parts[1])
    targets = {w.lower() for w in words}
    parts = load_parts()
    google = load_google()
    ecdict = load_ecdict(targets)
    print('words', len(words), 'parts', len(parts), 'google', len(google), 'ecdict', len(ecdict), file=sys.stderr)

    # Common base words already in com.data, for inflection filtering.
    base_words = set()
    try:
        for line in open(os.path.join(ROOT, 'com.data'), encoding='utf-8'):
            line = line.strip()
            if line:
                base_words.add(json.loads(line)['headWord'].lower())
    except Exception:
        pass
    try:
        sys.path.insert(0, os.path.join(tempfile.gettempdir(), 'dsh-lemminflect'))
        from lemminflect import getAllLemmas
    except Exception:
        getAllLemmas = None

    def is_inflection(word):
        if not getAllLemmas or not re.fullmatch(r'[a-z]+', word.lower()):
            return False
        try:
            m = getAllLemmas(word.lower())
        except Exception:
            return False
        lemmas = set()
        for ls in m.values():
            lemmas.update(x.lower() for x in ls)
        others = [x for x in lemmas if x != word.lower() and x in base_words]
        return bool(others)

    kept = []
    stats = {'part': 0, 'google': 0, 'ecdict': 0, 'dropped': 0, 'inflection': 0, 'duplicate': 0}
    seen = set()
    for w in words:
        lw = w.lower()
        if lw in seen:
            stats['duplicate'] += 1
            continue
        seen.add(lw)
        if is_inflection(w):
            stats['inflection'] += 1
            continue
        meaning = ''
        source = ''
        if lw in parts:
            meaning = clean_meaning(w, parts[lw])
            if meaning:
                source = 'part'
        if not meaning and lw in ecdict:
            meaning = clean_meaning(w, ecdict[lw][0])
            if meaning:
                source = 'ecdict'
        if not meaning and lw in google:
            meaning = clean_meaning(w, google[lw])
            if meaning:
                source = 'google'
        if not meaning:
            stats['dropped'] += 1
            continue
        stats[source] += 1
        pos = ecdict[lw][1] if lw in ecdict else ''
        kept.append((w, meaning, pos))
    print(json.dumps({'kept': len(kept), **stats}, ensure_ascii=False), file=sys.stderr)

    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        for i, (w, meaning, pos) in enumerate(kept, 1):
            entry = {
                'wordRank': i,
                'headWord': w,
                'content': {
                    'word': {
                        'wordHead': w,
                        'wordId': f'WTF_5000_{i}',
                        'content': {
                            'usphone': '',
                            'trans': [{'tranCn': meaning, 'pos': pos, 'descCn': '中释'}],
                            'note': 'OED 词频表',
                        },
                    }
                },
                'bookId': 'WTF_5000',
            }
            f.write(json.dumps(entry, ensure_ascii=False, separators=(',', ':')) + '\n')
    print('written', OUT, len(kept))


if __name__ == '__main__':
    main()
