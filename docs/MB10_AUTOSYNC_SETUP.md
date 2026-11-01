# التشغيل التلقائي لجلب بصمات MB10 — دوام الميسر (فرع التجربة 0.2.21)

## النتيجة المقصودة
- قراءة جهاز MB10 على عنوان LAN `192.168.0.121:4370` وإرسال الحركات عبر HTTPS إلى مشروع Cloudflare Pages التجريبي `dawam-muyassar-stage`.
- إتمام مزامنة جديدة كل **10 دقائق** بواسطة برنامج Python المحلي، من غير فتح PowerShell كل يوم، مع بقاء زر «جلب البصمة الآن» في التطبيق.
- مهمة Windows تبدأ **عند تسجيل الدخول** إلى حساب Windows الذي شُفّر عليه مفتاح `MB10_IMPORT_TOKEN.dpapi`، وتستمر أثناء قفل الشاشة طالما الجهاز يعمل ومتصل بالشبكة والإنترنت. **لا تعمل بعد تسجيل الخروج أو إطفاء الكمبيوتر أو دخوله السكون.**
- في حالة انقطاع الشبكة، تبقى حركات البصمة محفوظة في جهاز MB10، ويُعاد طلب الحركات عند عودة الاتصال. الإدخال في D1 يستخدم بصمة تعريف فريدة و`INSERT OR IGNORE` لمنع تكرار الحركات نفسها.
- لا تخزين لمفتاح MB10 في GitHub؛ المفتاح محفوظ مشفّرًا بـ DPAPI في ملف `$HOME\MB10_IMPORT_TOKEN.dpapi`، ويُفك مؤقتًا داخل عملية المستخدم عند تشغيل المهمة.

## التفعيل على كمبيوتر المكتب مرة واحدة
1. تحقق من نجاح الجلب اليدوي (تمت تجربة 268 حركة سابقًا) ومن وجود `pyzk`: `py -m pip show pyzk`.
2. **أوقف وكيل البصمة اليدوي** في PowerShell بالضغط على `Ctrl+C`، لأن تشغيل وكيلين في نفس الوقت غير مطلوب.
3. تأكد أن مستخدم Windows الحالي هو نفسه الذي أنشأ ملف `MB10_IMPORT_TOKEN.dpapi`، وأن الملف موجود في مجلد المستخدم. لا ترسل قيمة المفتاح لأحد.
4. افتح Windows PowerShell في الحساب نفسه ونفّذ:

```powershell
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/SalehAliAbuBaker/dawam-almuyassar/feature/dawam-0.2.0-foundation/tools/install_mb10_autosync.ps1" -OutFile "$HOME\Downloads\install_mb10_autosync.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$HOME\Downloads\install_mb10_autosync.ps1"
```

5. يجب أن تظهر `Installed and started: DawamMuyassar-MB10-AutoSync`، دون عرض المفتاح السري.
6. تحقق من تشغيل مهمة Windows والسجل المحلي:

```powershell
Get-ScheduledTask -TaskName "DawamMuyassar-MB10-AutoSync" | Select-Object TaskName,State
Get-Content "$env:LOCALAPPDATA\DawamMuyassar\MB10\sync.log" -Tail 15
```

7. في التطبيق افتح `https://dawam-muyassar-stage.pages.dev/mb10-sync.html` بحساب يملك صلاحية جلب البصمة. سترى **آخر جلب ناجح** وعدد الحركات المضافة والموجودة سابقًا، ويمكنك الضغط على «جلب البصمة الآن» للتجربة.
8. بعد الاطمئنان، أغلق **نافذة PowerShell التي أجريت منها التثبيت**، واقفل شاشة Windows فقط بدل تسجيل الخروج. لا توقف المهمة من مدير المهام.

## معرفة الأعطال والتوقف
- إذا انقضت 25 دقيقة دون جلب ناجح، تحقق من أن الكمبيوتر ما زال يعمل، ومن حالة المهمة، واتصال LAN بجهاز MB10، والإنترنت.
- إذا كان `State` يساوي `Running` فلا يعني هذا وحده أن الوصول إلى الجهاز ناجح؛ **راجع السجل النصي وحالة آخر مزامنة ناجحة في التطبيق**.
- إذا ظهر HTTP 401، تأكد أن الملف المشفّر والمفتاح المنشور في Cloudflare متطابقان. إذا ظهر HTTP 403 فافحص سياسة Cloudflare وتحديث برنامج Python.
- عند عودة الكهرباء أو الشبكة، استعد التشغيل من مهمة Windows؛ إذا تعطل برنامج Python فإعداد Windows يحاول إعادة تشغيل المهمة ثلاث مرات، ولا يكرر الحركات المسجلة.
- إذا بقي طلب جلب «جارٍ» أكثر من 30 دقيقة، ينتهي باعتباره متروكًا عند طلب جلب جديد كي لا يمنع الاستمرار في العمل.
- تتطلب المزامنة الدقيقة أن يكون توقيت جهاز MB10 صحيحًا؛ الجهاز هو المصدر الزمني. لا تعتمد خصومات آلية من الحركات غير محددة الرمز.

## إيقاف المزامنة التلقائية
```powershell
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/SalehAliAbuBaker/dawam-almuyassar/feature/dawam-0.2.0-foundation/tools/uninstall_mb10_autosync.ps1" -OutFile "$HOME\Downloads\uninstall_mb10_autosync.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$HOME\Downloads\uninstall_mb10_autosync.ps1"
```
إيقاف المهمة لا يحذف سجلات D1، ولا حركات جهاز البصمة، ولا ملف المفتاح المحلي.

## خطة الاستغناء عن كمبيوتر المكتب نفسه
هذا **غير منجز بعد**. تحقق أولًا من قائمة الجهاز `Menu → COMM → Cloud Server / ADMS` والدعم الفعلي في إصدار firmware. إذا كان جهاز MB10 يدعم PUSH/ADMS ويمكنه الوصول إلى الإنترنت بأمان، يلزم إنشاء مستقبِل بروتوكول ADMS موثوق ومصادق عليه وخاضع للتحقق، ثم اختبار وصول الحركات من الجهاز إلى الخادم دون كمبيوتر وسيط. لا تفتح المنفذ `4370` إلى الإنترنت، ولا تضبط عنوان Cloudflare Pages الحالي كـ ADMS بلا مستقبل مطابق للبروتوكول.
