
package com.irisvocal.irisvocal_backend.Controller;

import com.irisvocal.irisvocal_backend.Dto.LoginRequest;
import com.irisvocal.irisvocal_backend.Dto.RegisterRequest;
import com.irisvocal.irisvocal_backend.Model.User;
import com.irisvocal.irisvocal_backend.Service.UserService;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.authentication.AuthenticationManager;
import org.springframework.security.core.AuthenticationException;

import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.context.SecurityContextRepository;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@RestController
@RequestMapping("/api/auth")
public class UserController {

    private final UserService userService;
    private final AuthenticationManager authenticationManager;
    private final SecurityContextRepository securityContextRepository;

    public UserController(
            UserService userService,
            AuthenticationManager authenticationManager,
            SecurityContextRepository securityContextRepository) {
        this.userService = userService;
        this.authenticationManager = authenticationManager;
        this.securityContextRepository = securityContextRepository;
    }

    // Register a new user
    @PostMapping("/register")
    public ResponseEntity<Map<String, String>> registerUser(
            @Valid @RequestBody RegisterRequest request) {

        userService.registerUser(request);

        return ResponseEntity.status(HttpStatus.CREATED)
                .body(Map.of(
                        "message",
                        "User registered successfully"));
    }

    // Provide a CSRF token to the frontend
    @GetMapping("/csrf")
    public Map<String, String> csrf(CsrfToken csrfToken) {
        return Map.of("token", csrfToken.getToken());
    }

    // Log in and establish a session
    @PostMapping("/login")
    public ResponseEntity<?> loginUser(
            @Valid @RequestBody LoginRequest request,
            HttpServletRequest httpRequest,
            HttpServletResponse httpResponse) {

        try {
            //it is also an interface
            Authentication authentication =
                    authenticationManager.authenticate(
                            new UsernamePasswordAuthenticationToken(
                                    request.getEmail(),
                                    request.getPassword()));

            // Create or reuse the HTTP session
            httpRequest.getSession(true);

            // Protect against session fixation
            httpRequest.changeSessionId();

            // Save the authenticated user in Spring Security's context
            SecurityContext context =
                    SecurityContextHolder.createEmptyContext();

            context.setAuthentication(authentication);
            //This makes the context available as the current security context through Spring Security's SecurityContextHolder.
            SecurityContextHolder.setContext(context);

            // Persist the context in the HTTP session
            securityContextRepository.saveContext(
                    context, httpRequest, httpResponse);

            User user =
                    userService.findUserByEmail(authentication.getName());

            return ResponseEntity.ok(
                    Map.of(
                            "message", "Login successful",
                            "user", Map.of(
                                    "id", user.getId(),
                                    "name", user.getName(),
                                    "email", user.getEmail(),
                                    "emergencyContactEmail", user.getEmergencyContactEmail()
                            )
                    )
            );

        } catch (AuthenticationException exception) {

            SecurityContextHolder.clearContext();

            return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                    .body(Map.of(
                            "message",
                            "Invalid email or password"));
        }
    }
}
