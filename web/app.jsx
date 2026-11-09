import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const HOUR = 3_600_000;
const money = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 });
const dates = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Moscow' });
const formatDate = date => dates.format(date);
const levelName = level => `−${level} этаж`;
const fieldTime = timestamp => new Date(timestamp + 3 * HOUR).toISOString().slice(0, 16);
const nextHour = () => (Math.floor(Date.now() / HOUR) + 1) * HOUR;
const mallName = (malls, id) => malls.find(mall => mall.id === id)?.name ?? id;

async function api(path, method = 'GET', input) {
  const response = await fetch(`/api${path}`, {
    method,
    ...(input && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Не удалось выполнить запрос.');
  return data;
}

function ErrorText({ text }) {
  return text && <p className="error" role="alert">{text}</p>;
}

function Auth({ onClose, onUser }) {
  const dialog = useRef(null);
  const [register, setRegister] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => dialog.current.showModal(), []);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const fields = Object.fromEntries(new FormData(event.currentTarget));
      onUser(await api(register ? '/register' : '/login', 'POST', fields));
      dialog.current?.close();
    } catch (problem) {
      setError(problem.message);
    } finally {
      setBusy(false);
    }
  }

  return <dialog ref={dialog} onClose={onClose} aria-labelledby="auth-title">
    <div className="dialog-title">
      <h2 id="auth-title">{register ? 'Создать аккаунт' : 'Войти в аккаунт'}</h2>
      <button type="button" className="quiet" aria-label="Закрыть" onClick={() => dialog.current.close()}>✕</button>
    </div>
    <form className="stack" onSubmit={submit}>
      <label>Email <input name="email" type="email" maxLength="254" autoComplete="username" required /></label>
      <label>Пароль <input name="password" type="password" minLength="8" maxLength="128"
        autoComplete={register ? 'new-password' : 'current-password'} required /></label>
      <ErrorText text={error} />
      <button className="primary" disabled={busy}>{register ? 'Зарегистрироваться' : 'Войти'}</button>
      <button type="button" className="quiet" disabled={busy} onClick={() => { setRegister(!register); setError(''); }}>
        {register ? 'Уже есть аккаунт? Войти' : 'Впервые здесь? Создать аккаунт'}
      </button>
    </form>
  </dialog>;
}

function BookingForm({ malls, user, edit, onStopEdit, onAuth, onSave }) {
  const initialStart = nextHour();
  const [mallId, setMallId] = useState(edit?.mall_id ?? malls[0].id);
  const [start, setStart] = useState(fieldTime(edit?.starts_at ?? initialStart));
  const [end, setEnd] = useState(fieldTime(edit?.ends_at ?? initialStart + HOUR));
  const [quote, setQuote] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const interval = () => ({ mallId, start: Date.parse(start + '+03:00'), end: Date.parse(end + '+03:00') });
  const mall = malls.find(row => row.id === mallId);
  const available = quote?.floors.reduce((total, floor) => total + floor.available, 0);

  function change(setValue, value) {
    setValue(value);
    setQuote(null);
    setError('');
  }

  async function check(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const query = new URLSearchParams(interval());
      if (edit) query.set('bookingId', edit.id);
      setQuote(await api(`/availability?${query}`));
    } catch (problem) {
      setQuote(null);
      setError(problem.message);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!user) return onAuth();
    setError('');
    setBusy(true);
    try {
      const row = await api(edit ? `/bookings/${edit.id}` : '/bookings', edit ? 'PUT' : 'POST', interval());
      setQuote(null);
      onSave(row);
    } catch (problem) {
      setError(problem.message);
    } finally {
      setBusy(false);
    }
  }

  return <div className="booking-grid">
    <section className="panel">
      <p className="eyebrow">Бронирование</p>
      <h2>{edit ? 'Изменить бронирование' : 'Выберите парковку'}</h2>
      <form className="stack" onSubmit={check}>
        <fieldset disabled={busy}>
          <legend className="field-label">Торговый центр</legend>
          <div className="mall-grid">
            {malls.map(row => <label className="mall-option" key={row.id}>
              <input type="radio" name="mall" checked={mallId === row.id} onChange={() => change(setMallId, row.id)} />
              <span><strong>{row.name}</strong><small>{row.floors.length === 1 ? '1 этаж' : '2 этажа'}</small></span>
            </label>)}
          </div>
          <div className="time-grid">
            <label>Начало <input type="datetime-local" value={start} step="3600" required
              onChange={event => {
                const value = event.target.value;
                change(setStart, value);
                const timestamp = Date.parse(value + '+03:00');
                if (Number.isFinite(timestamp) && end <= value) setEnd(fieldTime(timestamp + HOUR));
              }} /></label>
            <label>Окончание <input type="datetime-local" value={end} step="3600" required
              onChange={event => change(setEnd, event.target.value)} /></label>
          </div>
        </fieldset>
        <p className="muted small">Укажите целые часы. Время московское, UTC+3.</p>
        <ErrorText text={error} />
        <div className="actions">
          <button className="primary" disabled={busy}>Проверить места</button>
          {edit && <button type="button" className="quiet" disabled={busy} onClick={onStopEdit}>Отменить редактирование</button>}
        </div>
      </form>
    </section>
    <aside className="panel summary" aria-live="polite">
      <p className="eyebrow">Ваш маршрут</p>
      <h2>{mall.name}</h2>
      {quote ? <>
        <div className="floor-list">
          {quote.floors.map(floor => <div className="spread" key={floor.level}>
            <span>{levelName(floor.level)}</span><strong>Свободно {floor.available} из {floor.capacity}</strong>
          </div>)}
        </div>
        <div className="spread total"><span>{quote.hours} ч × {money.format(quote.rate)}</span><strong>{money.format(quote.total)}</strong></div>
        <button className="primary" disabled={busy || !available} onClick={save}>
          {edit ? 'Сохранить изменения' : user ? 'Забронировать' : 'Войти для бронирования'}
        </button>
        <p className="muted small">{available ? 'Система назначит место на весь интервал.' : 'Выберите другое время или торговый центр.'}</p>
      </> : <>
        <div className="floor-list">
          {mall.floors.map(floor => <div className="spread" key={floor.level}>
            <span>{levelName(floor.level)}</span><strong>Всего {floor.capacity}</strong>
          </div>)}
        </div>
        <p className="muted">Проверьте выбранный интервал, чтобы увидеть свободные места и стоимость.</p>
      </>}
    </aside>
  </div>;
}

function Bookings({ malls, revision, onEdit, onCancel }) {
  const [rows, setRows] = useState(null);
  const [pending, setPending] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api('/bookings').then(result => { if (active) setRows(result); })
      .catch(problem => { if (active) setError(problem.message); });
    return () => { active = false; };
  }, [revision]);

  async function cancel(id) {
    setPending(id);
    setError('');
    try {
      await api(`/bookings/${id}`, 'DELETE');
      setConfirm(null);
      onCancel();
    } catch (problem) {
      setError(problem.message);
    } finally {
      setPending(null);
    }
  }

  return <section className="panel">
    <p className="eyebrow">Личный кабинет</p>
    <h2>Мои бронирования</h2>
    <ErrorText text={error} />
    {!rows && !error && <p className="muted">Загружаем бронирования…</p>}
    {rows?.length === 0 && <p className="muted">У вас пока нет бронирований.</p>}
    <div className="record-list">
      {rows?.map(row => {
        const canEdit = row.status === 'active' && row.starts_at > Date.now();
        const status = row.status === 'cancelled' ? 'Отменено' : row.ends_at <= Date.now() ? 'Завершено' :
          canEdit ? 'Подтверждено' : 'В процессе';
        return <article className="record" key={row.id}>
          <div className="spread"><h3>{mallName(malls, row.mall_id)}</h3><span className="badge">{status}</span></div>
          <p>{levelName(row.level)} · место №{row.spot} · <strong>{money.format(row.total_rub)}</strong></p>
          <p className="muted small">{formatDate(row.starts_at)} — {formatDate(row.ends_at)} (МСК)</p>
          {canEdit && <div className="actions">
            {confirm === row.id ? <>
              <button className="danger" disabled={pending !== null} onClick={() => cancel(row.id)}>Да, отменить бронь</button>
              <button className="quiet" disabled={pending !== null} onClick={() => setConfirm(null)}>Назад</button>
            </> : <>
              <button className="quiet" onClick={() => onEdit(row)}>Изменить</button>
              <button className="quiet" onClick={() => setConfirm(row.id)}>Отменить</button>
            </>}
          </div>}
        </article>;
      })}
    </div>
  </section>;
}

function FloorEditor({ mall, floor, onChange }) {
  const [capacity, setCapacity] = useState(floor.capacity);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/admin/floors/${mall.id}/${floor.level}`, 'PUT', { capacity: Number(capacity) });
      await onChange();
    } catch (problem) {
      setError(problem.message);
    } finally {
      setBusy(false);
    }
  }
  return <form className="record" onSubmit={save}>
    <h3>{mall.name} · {levelName(floor.level)}</h3>
    <div className="actions capacity-control">
      <label>Количество мест <input type="number" required min="0" max="10000" step="1" value={capacity}
        disabled={busy} onChange={event => setCapacity(event.target.value)} /></label>
      <button className="primary" disabled={busy || capacity === '' || Number(capacity) === floor.capacity}>Сохранить</button>
    </div>
    <p className="muted small">Создал {floor.created_by} · {formatDate(floor.created_at)}<br />
      Изменил {floor.updated_by} · {formatDate(floor.updated_at)}</p>
    <ErrorText text={error} />
  </form>;
}

function Audit({ type, malls, revision }) {
  const [page, setPage] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    api(`/admin/audit/${type}`).then(result => { if (active) setPage(result); })
      .catch(problem => { if (active) setError(problem.message); });
    return () => { active = false; };
  }, [type, revision]);

  async function loadMore() {
    setError('');
    setBusy(true);
    try {
      const result = await api(`/admin/audit/${type}?before=${page.next}`);
      setPage({ entries: [...page.entries, ...result.entries], next: result.next });
    } catch (problem) {
      setError(problem.message);
    } finally {
      setBusy(false);
    }
  }

  function detail(row) {
    if (!row) return '—';
    if (type === 'capacity') return `${row.capacity} мест`;
    const status = row.status === 'cancelled' ? 'отменено' : 'активно';
    return `${mallName(malls, row.mall_id)}, ${levelName(row.level)}, №${row.spot} · ${formatDate(row.starts_at)} — ${formatDate(row.ends_at)} · ${money.format(row.total_rub)} · ${status}`;
  }
  const actions = { create: 'Создание', update: 'Изменение', cancel: 'Отмена' };
  return <>
    <ErrorText text={error} />
    {!page && !error && <p className="muted">Загружаем журнал…</p>}
    {page?.entries.length === 0 && <p className="muted">Записей пока нет.</p>}
    <div className="record-list">
      {page?.entries.map(entry => <article className="record" key={entry.id}>
        <div className="spread"><h3>{actions[entry.action]}</h3><span className="badge">#{entry.id}</span></div>
        <p>{type === 'capacity' ? `${mallName(malls, entry.next.mall_id)} · ${levelName(entry.next.level)}` : entry.entity_id}</p>
        <p className="muted small">{entry.actor} · {entry.source === 'seed' ? 'Инициализация' : 'Веб-приложение'} · {formatDate(entry.changed_at)} (МСК)</p>
        <dl className="audit-data"><dt>Было</dt><dd>{detail(entry.previous)}</dd><dt>Стало</dt><dd>{detail(entry.next)}</dd></dl>
      </article>)}
    </div>
    {page?.next && <button className="quiet more" disabled={busy} onClick={loadMore}>Показать ещё</button>}
  </>;
}

function Admin({ malls, onChange }) {
  const [section, setSection] = useState('floors');
  const [revision, setRevision] = useState(0);
  const sections = { floors: 'Вместимость', capacity: 'Журнал вместимости', booking: 'Журнал бронирований' };
  return <section className="panel">
    <p className="eyebrow">Панель администратора</p>
    <h2>Управление парковками</h2>
    <div className="actions tabs" aria-label="Раздел панели">
      {Object.entries(sections).map(([key, title]) => <button key={key} className="quiet"
        aria-pressed={section === key} onClick={() => setSection(key)}>{title}</button>)}
    </div>
    {section === 'floors' ? <div className="record-list">
      {malls.flatMap(mall => mall.floors.map(floor => <FloorEditor mall={mall} floor={floor}
        key={`${mall.id}-${floor.level}-${floor.updated_at}`} onChange={async () => {
          await onChange();
          setRevision(value => value + 1);
        }} />))}
    </div> : <Audit key={section} type={section} malls={malls} revision={revision} />}
  </section>;
}

function App() {
  const [malls, setMalls] = useState(null);
  const [user, setUser] = useState(null);
  const [view, setView] = useState('book');
  const [auth, setAuth] = useState(false);
  const [edit, setEdit] = useState(null);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api('/malls'), api('/session')]).then(([list, session]) => {
      setMalls(list);
      setUser(session);
      if (session?.role === 'admin') setView('admin');
    }).catch(problem => setError(problem.message));
  }, []);

  function switchView(value) {
    setEdit(null);
    setNotice('');
    setView(value);
  }

  async function logout() {
    try {
      await api('/logout', 'POST');
      setUser(null);
      switchView('book');
    } catch (problem) {
      setError(problem.message);
    }
  }

  return <>
    <header className="header">
      <div className="frame header-inner">
        <button className="brand" onClick={() => switchView(user?.role === 'admin' ? 'admin' : 'book')}>
          <span className="brand-mark" aria-hidden="true">P</span><span>ФОРУМ <small>ПАРКИНГ</small></span>
        </button>
        <nav aria-label="Основная навигация">
          {user?.role === 'visitor' && <>
            <button className="nav-button" aria-current={view === 'book' ? 'page' : undefined} onClick={() => switchView('book')}>Парковка</button>
            <button className="nav-button" aria-current={view === 'mine' ? 'page' : undefined} onClick={() => switchView('mine')}>Мои брони</button>
          </>}
          {user ? <button className="nav-button account" title={user.email} onClick={logout}>Выйти</button>
            : <button className="nav-button account" onClick={() => setAuth(true)}>Войти</button>}
        </nav>
      </div>
    </header>
    <main className="frame">
      <section className="hero">
        <div><p className="eyebrow">Сеть торговых центров «Форум»</p>
          <h1>{view === 'admin' ? 'Парковки под контролем' : view === 'mine' ? 'Ваши поездки в Форум' : 'Парковка к вашему приезду'}</h1>
          <p>{view === 'admin' ? 'Управляйте местами по этажам и просматривайте историю изменений.'
            : 'Запланируйте визит и забронируйте место в подземном паркинге.'}</p></div>
        <span className="hero-mark" aria-hidden="true">P</span>
      </section>
      <ErrorText text={error} />
      {notice && <p className="notice" role="status">{notice}</p>}
      {!malls && !error && <p className="muted">Загружаем парковки…</p>}
      {malls && view === 'book' && <BookingForm key={edit?.id ?? 'new'} malls={malls} user={user} edit={edit}
        onAuth={() => setAuth(true)} onStopEdit={() => switchView('mine')} onSave={row => {
          switchView('mine');
          setNotice(`Бронь ${edit ? 'обновлена' : 'подтверждена'}. ${mallName(malls, row.mall_id)} · ${levelName(row.level)} · место №${row.spot}.`);
        }} />}
      {malls && view === 'mine' && <Bookings malls={malls} revision={revision} onEdit={row => {
        switchView('book');
        setEdit(row);
      }} onCancel={() => {
        setRevision(value => value + 1);
        setNotice('Бронь отменена.');
      }} />}
      {malls && view === 'admin' && <Admin malls={malls} onChange={async () => setMalls(await api('/malls'))} />}
    </main>
    <footer className="frame"><strong>Форум Паркинг</strong><span>Москва · время МСК</span></footer>
    {auth && <Auth onClose={() => setAuth(false)} onUser={session => {
      setUser(session);
      if (session.role === 'admin') switchView('admin');
    }} />}
  </>;
}

createRoot(document.getElementById('root')).render(<App />);
