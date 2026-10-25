import { h, icon, api, toast } from '../core.js';

export function loginView() {
  const login = h('input.input', { placeholder: 'Логин', autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false' });
  const password = h('input.input', { type: 'password', placeholder: 'Пароль', autocomplete: 'current-password' });
  const btn = h('button.btn.primary.block', { type: 'submit' }, 'Войти');

  const submit = async (e) => {
    e.preventDefault();
    btn.disabled = true;
    try {
      await api('/login', { method: 'POST', body: { login: login.value, password: password.value } });
      location.hash = '#/';
    } catch (err) {
      toast(err.message, true);
      password.select();
    } finally {
      btn.disabled = false;
    }
  };

  return h('div.login',
    h('div.logo', icon('sparkles')),
    h('h1', 'Порядок'),
    h('p.lead', 'Уборки квартиры — без чатов и путаницы'),
    h('form.stack', { onsubmit: submit }, login, password, h('div', { style: { height: '6px' } }), btn),
    h('div.hint', 'Логин и пароль выдаёт шеф'));
}
