-- 纪念日支持:kind 区分生日/纪念日;avatar 为系统头像标识('a1'~'a5')
ALTER TABLE birthdays ADD COLUMN kind TEXT NOT NULL DEFAULT 'birthday';
ALTER TABLE birthdays ADD COLUMN avatar TEXT;
