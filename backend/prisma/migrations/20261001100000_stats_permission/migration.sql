-- Право «Статистика» (stats.view) — управляющим, как в пресете роли MANAGER.
-- Владелец получает все права и так. Остальным — по желанию владельца.
--
-- "Role" под FORCE ROW LEVEL SECURITY: без режима платформы владелец схемы
-- не увидел бы ни одной строки, и обновление молча прошло бы мимо.
DO $$
BEGIN
  PERFORM set_config('app.platform', 'on', true);
  UPDATE "Role"
     SET permissions = array_append(permissions, 'stats.view')
   WHERE code = 'MANAGER' AND NOT ('stats.view' = ANY (permissions));
END $$;
