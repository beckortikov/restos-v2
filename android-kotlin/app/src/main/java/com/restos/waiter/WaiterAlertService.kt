package com.restos.waiter

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.restos.core.auth.TokenStore
import com.restos.core.events.EventBus
import com.restos.core.events.ServerEvent
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicInteger
import javax.inject.Inject

/**
 * WaiterAlertService — foreground-сервис, который держит SSE живым в фоне и шлёт
 * официанту звуковое уведомление, когда повар отметил ЕГО блюдо готовым
 * (событие kds.item.updated со status=ready и waiter_id текущего пользователя).
 *
 * Без foreground-сервиса Android убивает фоновый процесс → SSE обрывается и
 * уведомления не приходят. LAN-приложение не может использовать FCM, поэтому
 * держим соединение сами.
 */
@AndroidEntryPoint
class WaiterAlertService : Service() {

    @Inject lateinit var eventBus: EventBus
    @Inject lateinit var tokenStore: TokenStore

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val notifSeq = AtomicInteger(1000)
    @Volatile private var myId: String? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannels()
        startForeground(SERVICE_NOTIF_ID, buildServiceNotification())
        scope.launch { myId = runCatching { tokenStore.currentMe()?.user?.id }.getOrNull() }
        scope.launch {
            eventBus.events.collect { evt ->
                val me = myId ?: return@collect
                when {
                    evt is ServerEvent.KdsItemUpdated && evt.status == "ready" && evt.waiterId == me ->
                        notifyReady(evt)
                    evt is ServerEvent.WaiterCalled && evt.waiterId == me ->
                        notifyCall(evt)
                }
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun notifyReady(evt: ServerEvent.KdsItemUpdated) {
        val nm = getSystemService(NotificationManager::class.java) ?: return
        val dish = evt.name?.takeIf { it.isNotBlank() } ?: "Блюдо"
        val order = evt.orderNumber?.let { " · Заказ #$it" } ?: ""
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val n = NotificationCompat.Builder(this, CH_READY)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Готово к выдаче")
            .setContentText("«$dish» готово$order")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setAutoCancel(true)
            .setContentIntent(open)
            .build()
        nm.notify(notifSeq.incrementAndGet(), n)
    }

    private fun notifyCall(evt: ServerEvent.WaiterCalled) {
        val nm = getSystemService(NotificationManager::class.java) ?: return
        val place = when {
            evt.tableNumber != null -> "Стол ${evt.tableNumber}"
            !evt.tableName.isNullOrBlank() -> evt.tableName!!
            else -> null
        }
        val order = evt.orderNumber?.let { "Заказ #$it" }
        val where = listOfNotNull(place, order).joinToString(" · ")
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val n = NotificationCompat.Builder(this, CH_CALL)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Вас зовут на кухню")
            .setContentText(if (where.isNotBlank()) "Подойдите на кухню · $where" else "Подойдите на кухню")
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setAutoCancel(true)
            .setContentIntent(open)
            .build()
        nm.notify(notifSeq.incrementAndGet(), n)
    }

    private fun buildServiceNotification() =
        NotificationCompat.Builder(this, CH_SERVICE)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("RestOS Официант")
            .setContentText("На связи — уведомления о готовности включены")
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .build()

    private fun createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java) ?: return
        nm.createNotificationChannel(
            NotificationChannel(CH_SERVICE, "Фоновая связь", NotificationManager.IMPORTANCE_LOW)
                .apply { setShowBadge(false) },
        )
        val ready = NotificationChannel(CH_READY, "Готовые блюда", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Сигнал, когда блюдо готово к выдаче"
            enableVibration(true)
            // Звук на потоке уведомлений; громкий и слышимый даже когда экран потушен.
            val sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
            val attrs = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_EVENT)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
            setSound(sound, attrs)
        }
        nm.createNotificationChannel(ready)

        val call = NotificationChannel(CH_CALL, "Вызов на кухню", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Повар зовёт официанта на кухню"
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 300, 200, 300)
            val sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
            val attrs = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_EVENT)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
            setSound(sound, attrs)
        }
        nm.createNotificationChannel(call)
    }

    companion object {
        const val CH_SERVICE = "waiter_service"
        const val CH_READY = "waiter_ready"
        const val CH_CALL = "waiter_call"
        const val SERVICE_NOTIF_ID = 42
    }
}
