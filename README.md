
Группа компаний Форум имеет в городе несколько больших ТЦ с подземной парковкой и нуждается в системе бронирования парковочных мест. По результатам общения с заказчиком аналитик проекта сформировал требования к системе.
1.	У компании есть 3 ТЦ: Форум Север, Форум Юго-Запад и Форум Центр. Форум Центр имеет 2-хэтажный паркинг, остальные – одноэтажный. Информацией о количестве парковочных мест должен управлять администратор компании.
2.	Тарификация парковки идет по целым часам. 
3.	Посетителю ТЦ может быть предложено любое из мест, доступных в заданный интервал времени в заданном ТЦ.
4.	Для самостоятельного бронирования посетителем ТЦ парковочного места должен быть реализован мобильный клиент. Способ интеграции и формат взаимодействия определяет разработчик системы. В качестве мобильного клиента выступает telegram bot или react web приложение.
5.	Распознавание номеров автомобиля камерами при въезде и оплата парковки выходят за скоуп системы.
6.	Аудит изменений: для данных о бронированиях и изменениях размера парковки должны фиксироваться: автор, последний редактор (источник изменений), дата создания и последнего изменения. Должен быть предусмотрен журнал изменений по каждому типу данных.
7.	Все данные из системы должны выгружаться на регулярной основе (раз в неделю) в виде файла(-ов) в формате JSON, должна быть возможность восстановить данные в системе на дату выгрузки при помощи этого файла.
8.	Предоставить заказчику helm чарты для развертывания приложения в k8s.
9.	Предоставить заказчику описание CI пайплайна для GitLab в файле .gitlab-ci. Пайплайн должен содержать прогон тестов и, по возможности, другие процедуры контроля качества кода. Merge Request должен завершаться установкой сервиса в k8s. 
10.	Разработка должна вестись в репозитории GitHub по методологии Gitflow.

---

# Форум Паркинг

Мобильное веб-приложение для бронирования мест в подземных паркингах трёх ТЦ. React-клиент и HTTP API обслуживаются одним приложением на Node.js 22, данные хранятся в SQLite. Посетитель проверяет наличие мест, регистрируется, бронирует место и может изменить или отменить бронь до начала парковки. Администратор задаёт вместимость каждого этажа и просматривает два журнала изменений.

В задании не указаны тариф, начальная вместимость и часовой пояс. В лабораторной используются **100 ₽/ч**, **60** мест на Севере, **45** на Юго-Западе и **70 + 60** в Центре. В интерфейсе время отображается по Москве. Начало и конец брони приходятся на целый час. Интервал включает начало и исключает конец, поэтому две последовательные брони могут использовать одно место. При изменении интервала цена пересчитывается по действующему тарифу. Существующая бронь хранит свой тариф. Настройки тарифа и вместимости меняются через переменную окружения и панель администратора соответственно.

## Запуск на Windows

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run build
Copy-Item .env.example .env
```

Задайте `ADMIN_PASSWORD` в файле `.env` и запустите `npm.cmd start`. Приложение доступно по адресу [127.0.0.1:3000](http://127.0.0.1:3000/). Для входа в панель используйте адрес `ADMIN_EMAIL` (по умолчанию `admin@forum.test`) и выбранный пароль. Для демонстрации посетителя создайте отдельную учётную запись в интерфейсе. Без пароля администратора доступно бронирование посетителем.

Порядок демонстрации:

1. Выберите «Форум Центр», проверьте свободные места на двух этажах и цену за два часа.
2. Создайте аккаунт, подтвердите бронь, проверьте номер места в разделе «Мои брони». Измените интервал и отмените бронь.
3. Войдите как администратор, измените вместимость этажа и откройте оба журнала. В них видны время, автор, источник и состояние до и после изменения.

## Развёртывание в Kubernetes

Требуются Kubernetes 1.27+ с доступным StorageClass для тома ReadWriteOnce, Helm 4 и Docker для сборки образа. В новом кластере создайте namespace и Secret `forum-parking-runtime` с двумя ключами `admin-password` и `backup-token`. Для администратора используйте пароль длиной 8–128 символов, для выгрузки — отдельный случайный токен. Пример для Bash, где значения предварительно заданы в окружении:

```bash
kubectl create namespace forum-lab
kubectl -n forum-lab create secret generic forum-parking-runtime \
  --from-literal=admin-password="$ADMIN_PASSWORD" \
  --from-literal=backup-token="$BACKUP_TOKEN"
```

Для локального kind-кластера соберите образ и загрузите его прямо на узел. Если кластера ещё нет, сначала выполните `kind create cluster --name forum-parking`, затем создайте namespace и Secret по примеру выше.

```powershell
docker build -t forum-parking:1.0.0 .
kind load docker-image forum-parking:1.0.0 --name forum-parking
helm lint --strict helm/forum-parking
helm upgrade --install forum-parking helm/forum-parking -n forum-lab --wait --rollback-on-failure --timeout 3m
helm test forum-parking -n forum-lab --timeout 90s
kubectl -n forum-lab port-forward svc/forum-parking 3000:3000
```

В подготовленном на этой машине кластере добавляйте `--kubeconfig .tools/kubeconfig` к командам Helm и kubectl. Бинарники находятся в `.tools/kind.exe`, `.tools/kubectl.exe` и `.tools/helm/windows-amd64/helm.exe`. Пароль администратора для этого стенда хранится в `.tools/demo-admin-password.txt`.

Для удалённого кластера опубликуйте образ в доступном ему Registry и передайте в Helm значения `image.repository`, `image.tag` и при необходимости `imagePullSecrets`. При доступе через HTTPS установите `secureCookie=true`. Чарт создаёт Deployment с одной репликой и стратегией Recreate, Service, PVC и CronJob. Для управляемого отдельно PVC укажите `persistence.existingClaim`.

## Выгрузка и восстановление

CronJob запускается **каждый понедельник в 03:00 по Москве**. Он обращается к приложению внутри кластера по токену. Приложение снимает согласованный снимок SQLite и сохраняет JSON в `/data/backups` на PVC. Копия содержит пользователей с хешами паролей, вместимость этажей, брони и аудит. Пароль администратора и токен выгрузки хранятся в Secret. Сеансы хранятся в памяти и сбрасываются при перезапуске приложения.

```powershell
# Запустить задание вручную и увидеть имя JSON-файла
kubectl -n forum-lab create job forum-backup-demo --from=cronjob/forum-parking-backup
kubectl -n forum-lab wait --for=condition=complete job/forum-backup-demo --timeout=120s
kubectl -n forum-lab logs job/forum-backup-demo

# Скопировать файл из Pod и при необходимости восстановить его
$file = (kubectl -n forum-lab logs job/forum-backup-demo | Select-String '^forum-.*\.json$').Line
$pod = kubectl -n forum-lab get pod -l app.kubernetes.io/instance=forum-parking -o jsonpath='{.items[0].metadata.name}'
kubectl -n forum-lab cp "${pod}:/data/backups/$file" ./backup.json
kubectl -n forum-lab cp --no-preserve ./backup.json "${pod}:/data/restore.json"
kubectl -n forum-lab exec deployment/forum-parking -- node server/backup.mjs restore /data/restore.json
```

Скопированный JSON можно хранить отдельно от кластера.

Для локального запуска используйте `npm.cmd run backup -- export` и `npm.cmd run backup -- restore data/backups/<file>.json`. Выгрузку можно запускать еженедельно через Планировщик заданий Windows, указав корень проекта как рабочий каталог. Восстановление заменяет текущие данные одной транзакцией. При ошибке данные до восстановления сохраняются.

## GitLab CI и Gitflow

[.gitlab-ci.yml](.gitlab-ci.yml) описывает проверки, сборку и развёртывание. Сначала запускаются интеграционные тесты, сборка React, npm audit и Helm lint. Для Merge Request или Pull Request из того же репозитория GitLab собирает и публикует контейнер по SHA коммита, устанавливает отдельный Helm-релиз и выполняет smoke-тест. Ветки `main` и `develop` проходят проверки при push.

1. Подключите репозиторий GitHub в GitLab через **Run CI/CD for external repository**. Этот режим обрабатывает GitHub Pull Request как `external_pull_request_event` и доступен в GitLab Premium и Ultimate. Для GitLab-репозитория используется `merge_request_event`. [Документация GitLab](https://docs.gitlab.com/ci/ci_cd_for_external_repos/)
2. Включите Container Registry и настройте GitLab Runner с Docker executor и поддержкой rootless BuildKit. [Сборка через BuildKit](https://docs.gitlab.com/ci/docker/using_buildkit/)
3. Подключите Kubernetes через GitLab Agent и задайте переменные `KUBE_CONTEXT` и `KUBE_NAMESPACE`. Разрешите агенту работу с Deployment, Service, Pod, PVC, CronJob и Secret в пространстве для проверки. Создайте там `forum-parking-runtime` и Secret для чтения Registry `forum-parking-registry`. [Настройка GitLab Agent](https://docs.gitlab.com/user/clusters/agent/ci_cd_workflow/)
4. Откройте запрос на слияние из `feature/*` в `develop`. После успешной проверки удаляйте ненужные окружения командой `helm uninstall <release> -n <namespace>` после сохранения данных. Подготовка релиза идёт в `release/*`, слияние — в `main` и `develop`. Версия помечается тегом `v1.0.0`.
