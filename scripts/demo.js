// Заполняет базу примерными данными, чтобы посмотреть интерфейс. Не запускайте на рабочей базе!
import { all, get, run, today, ymd, seedAccounts, nowStr } from '../server/db.js';
import { createCleaning } from '../server/cleanings.js';

seedAccounts();
if (get('SELECT COUNT(*) n FROM cleanings').n > 0) {
  console.log('В базе уже есть уборки — демо-данные не добавлены.');
  process.exit(0);
}
const [anna, maria] = all("SELECT id FROM users WHERE role = 'cleaner' ORDER BY id").map((u) => u.id);
const chief = get("SELECT id FROM users WHERE role = 'chief'").id;
const d = (n) => ymd(new Date(Date.now() + n * 86400000));

const done = (c, who, paid = false) => {
  run("UPDATE checklist_items SET done = 1, done_at = ? WHERE cleaning_id = ?", nowStr(), c.id);
  run("UPDATE cleanings SET status = 'done', cleaner_id = ?, started_at = ?, finished_at = ?, comment = ? WHERE id = ?",
    who, `${c.date} 11:05:00`, `${c.date} 13:20:00`, 'Всё чисто. В ванной слабо держится крючок для полотенца.', c.id);
};

done(createCleaning({ date: d(-6), start_time: '11:00', end_time: '14:00', cleaner_id: anna }), anna);
done(createCleaning({ date: d(-4), start_time: '11:00', cleaner_id: maria }), maria);
done(createCleaning({ date: d(-2), start_time: '12:00', type: 'general', cleaner_id: anna }), anna);

const inProgress = createCleaning({ date: today(), start_time: '11:00', end_time: '14:00', cleaner_id: anna, note: 'Заезд в 14:00 — гости с ребёнком, поставить детскую кроватку' });
run("UPDATE cleanings SET status = 'in_progress', started_at = ? WHERE id = ?", nowStr(), inProgress.id);
run('UPDATE checklist_items SET done = 1 WHERE cleaning_id = ? AND position < 9', inProgress.id);

const acc = createCleaning({ date: d(2), start_time: '11:00', cleaner_id: maria });
run("UPDATE cleanings SET status = 'accepted' WHERE id = ?", acc.id);
createCleaning({ date: d(3), start_time: '12:00', end_time: '15:00', cleaner_id: anna });
const decl = createCleaning({ date: d(5), start_time: '11:00', cleaner_id: maria });
run("UPDATE cleanings SET status = 'declined', decline_reason = 'Уезжаю к родителям' WHERE id = ?", decl.id);
createCleaning({ date: d(7), start_time: '11:00', end_time: '14:00', source: 'ical' });
createCleaning({ date: d(10), start_time: '11:00', type: 'general', cleaner_id: anna });

run('INSERT INTO purchases(title, note, created_by) VALUES(?,?,?)', 'Средство для стёкол', 'Clin, 2 шт', anna);
run('INSERT INTO purchases(title, created_by) VALUES(?,?)', 'Мешки для мусора 60 л', maria);
run('INSERT INTO purchases(title, note, created_by) VALUES(?,?,?)', 'Капсулы для кофемашины', 'Nespresso', chief);
run("INSERT INTO purchases(title, created_by, status, bought_by, bought_at, amount) VALUES(?,?,?,?,?,?)", 'Туалетная бумага', anna, 'bought', anna, nowStr(), 450);

run('INSERT INTO problems(kind, description, created_by, cleaning_id) VALUES(?,?,?,?)', 'breakage', 'Не работает одна конфорка на плите (левая дальняя)', maria, 2);
run('INSERT INTO problems(kind, description, created_by, cleaning_id) VALUES(?,?,?,?)', 'forgotten', 'Гости забыли зарядку от iPhone. Положила в верхний ящик комода.', anna, 3);

run('INSERT INTO notifications(user_id, title, body, link) VALUES(?,?,?,?)', chief, 'Мария отказалась от уборки', 'Уезжаю к родителям. Назначьте другую уборщицу.', `#/cleaning/${decl.id}`);
run('INSERT INTO notifications(user_id, title, body, link) VALUES(?,?,?,?)', anna, 'Новая уборка', 'Генеральная уборка', '#/');
run(`INSERT INTO settings(key, value) VALUES('apartment', ?)`, JSON.stringify({
  name: 'Квартира на Тверской', address: 'ул. Тверская, 12, кв. 45 · 3 подъезд, 7 этаж',
  info: 'Ключи: в ключнице у двери, код 2580\nWi‑Fi: Tverskaya45 / пароль 12345678\nБельё и полотенца: шкаф в коридоре, верхняя полка\nМусор: контейнеры во дворе слева',
}));
console.log('Демо-данные добавлены.');
