// A Java program against an SDK generated from the Kitchen example API: a client, a call and its typed error, and
// an event stream released by try-with-resources. Compiled against the generated SDK in the docs' tests.
import com.example.kitchen.ApiException;
import com.example.kitchen.EventStream;
import com.example.kitchen.GetApiEventsParams;
import com.example.kitchen.GetApiHealthParams;
import com.example.kitchen.KitchenClient;
import com.example.kitchen.SseEvent;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

public final class Example {
  private Example() {}

  static KitchenClient newClient() {
    return KitchenClient.builder()
        .baseUrl("https://api.example.com")
        .bearerToken(System.getenv("KITCHEN_TOKEN"))
        .timeout(Duration.ofSeconds(10))
        .build();
  }

  static String checkHealth(KitchenClient client) {
    try {
      client.getApiHealth(GetApiHealthParams.builder().build());
      return null;
    } catch (ApiException failed) {
      return "health check answered " + failed.status();
    }
  }

  static List<String> firstEvents(KitchenClient client, int limit) {
    List<String> seen = new ArrayList<>();
    // try-with-resources frees the connection, a break out of the loop included
    try (EventStream<String> stream = client.getApiEvents(GetApiEventsParams.builder().build())) {
      for (SseEvent<String> event : stream) {
        seen.add(event.data());
        if (seen.size() == limit) {
          break;
        }
      }
    }
    return seen;
  }

  public static void main(String[] args) {
    if (args.length < 1) {
      return;
    }
    KitchenClient client = newClient();
    System.out.println(checkHealth(client));
    System.out.println(firstEvents(client, 2));
  }
}
